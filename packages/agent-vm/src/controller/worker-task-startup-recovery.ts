import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
	appendEvent,
	applyEvent,
	createInitialState,
	isTerminal,
	workerConfigSchema,
	type TaskConfig,
	type TaskEvent,
	type TaskState,
} from '@agent-vm/agent-vm-worker';

import type { GatewayZone } from '../gateway/gateway-zone-support.js';
import {
	buildRepoResourceProviderComposeProjectName,
	type StartedRepoResourceProvider,
} from '../resources/repo-resource-provider-runner.js';
import {
	writeTaskFailureSentinel,
	type WriteTaskFailureSentinelOptions,
} from './task-state-reader.js';
import { postStopGateway } from './worker-task-runner.js';

export const workerTaskRestartFailureReason = 'controller-restarted-mid-task';

export type TaskLogRecoveryClassification = 'terminal' | 'needs-failure-event' | 'unreadable';

interface WorkerTaskStartupRecoverySystemConfig {
	readonly runtimeDir: string;
	readonly zones: readonly GatewayZone[];
}

export interface RecoverOrphanedWorkerTasksOptions {
	readonly systemConfig: WorkerTaskStartupRecoverySystemConfig;
	readonly zoneIds?: readonly string[];
}

export interface WorkerTaskStartupRecoveryResult {
	readonly recoveredCount: number;
	readonly warnings: readonly string[];
}

interface TaskLogEventForRecovery {
	readonly data: {
		readonly event: string;
	};
}

interface CleanupTaskRuntimeOptions {
	readonly runtimeDir: string;
	readonly taskId: string;
	readonly zone: GatewayZone;
}

type TaskFailedEvent = Extract<TaskEvent, { readonly event: 'task-failed' }>;
type PostStopGatewayFn = typeof postStopGateway;

interface WorkerTaskStartupRecoveryDependencies {
	readonly appendEvent?: (eventLogPath: string, event: TaskFailedEvent) => Promise<void>;
	readonly classifyTaskEventLogForRecovery?: (
		eventLogPath: string,
	) => Promise<TaskLogRecoveryClassification>;
	readonly cleanupTaskRuntime?: (
		options: CleanupTaskRuntimeOptions,
	) => Promise<readonly string[] | void>;
	readonly listTaskIds?: (zone: GatewayZone) => Promise<readonly string[]>;
	readonly postStopGateway?: PostStopGatewayFn;
	readonly quarantineEventLog?: (eventLogPath: string) => Promise<void>;
	readonly readTaskAcceptedConfig?: (eventLogPath: string) => Promise<TaskConfig | null>;
	readonly writeFailureSentinel?: (options: WriteTaskFailureSentinelOptions) => Promise<void>;
}

const terminalTaskEventNames = new Set(['task-completed', 'task-failed', 'task-closed']);
const workerTaskIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const repoIdPattern = /^[a-z0-9][a-z0-9_-]*$/u;

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		Reflect.get(error, 'code') === code
	);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskConfig(value: unknown): value is TaskConfig {
	if (!isPlainRecord(value)) {
		return false;
	}
	const effectiveConfig = Reflect.get(value, 'effectiveConfig');
	return (
		typeof Reflect.get(value, 'taskId') === 'string' &&
		typeof Reflect.get(value, 'prompt') === 'string' &&
		Array.isArray(Reflect.get(value, 'repos')) &&
		isPlainRecord(Reflect.get(value, 'context')) &&
		workerConfigSchema.safeParse(effectiveConfig).success
	);
}

function isAcceptedTaskEventLogRecord(value: unknown): value is {
	readonly data: {
		readonly config: TaskConfig;
		readonly event: 'task-accepted';
		readonly taskId: string;
	};
	readonly ts: string;
} {
	if (!isPlainRecord(value)) {
		return false;
	}
	const data = Reflect.get(value, 'data');
	return (
		typeof Reflect.get(value, 'ts') === 'string' &&
		isPlainRecord(data) &&
		Reflect.get(data, 'event') === 'task-accepted' &&
		typeof Reflect.get(data, 'taskId') === 'string' &&
		isTaskConfig(Reflect.get(data, 'config'))
	);
}

function isTimestampedTaskEventLogRecord(value: unknown): value is {
	readonly data: TaskEvent;
	readonly ts: string;
} {
	if (!isPlainRecord(value)) {
		return false;
	}
	const data = Reflect.get(value, 'data');
	return (
		typeof Reflect.get(value, 'ts') === 'string' &&
		isPlainRecord(data) &&
		typeof Reflect.get(data, 'event') === 'string'
	);
}

function getTaskStateDir(zone: GatewayZone, taskId: string): string {
	return path.join(zone.gateway.stateDir, 'tasks', taskId, 'state');
}

function getTaskEventLogPath(zone: GatewayZone, taskId: string): string {
	return path.join(getTaskStateDir(zone, taskId), 'tasks', `${taskId}.jsonl`);
}

function getTaskFailureSentinelPathForEventLog(eventLogPath: string): string {
	const eventLogDirectory = path.dirname(eventLogPath);
	const taskId = path.basename(eventLogPath, '.jsonl');
	return path.join(eventLogDirectory, `${taskId}.failed`);
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return false;
		}
		throw error;
	}
}

async function listWorkerTaskIds(zone: GatewayZone): Promise<readonly string[]> {
	const taskRoot = path.join(zone.gateway.stateDir, 'tasks');
	try {
		const entries = await fs.readdir(taskRoot, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && workerTaskIdPattern.test(entry.name))
			.map((entry) => entry.name)
			.toSorted((left, right) => left.localeCompare(right));
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return [];
		}
		throw error;
	}
}

async function eventLogEndsWithNewline(eventLogPath: string, byteSize: number): Promise<boolean> {
	if (byteSize === 0) {
		return false;
	}
	const fileHandle = await fs.open(eventLogPath, 'r');
	try {
		const buffer = Buffer.alloc(1);
		await fileHandle.read(buffer, 0, 1, byteSize - 1);
		return buffer[0] === 0x0a;
	} finally {
		await fileHandle.close();
	}
}

async function loadTaskStateFromEventLogForRecovery(
	eventLogPath: string,
): Promise<TaskState | null> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(eventLogPath);
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return null;
		}
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
		return null;
	}
	if (!(await eventLogEndsWithNewline(eventLogPath, stat.size))) {
		return null;
	}

	const lines = createInterface({
		crlfDelay: Infinity,
		input: createReadStream(eventLogPath, { encoding: 'utf8' }),
	});
	let lineNumber = 0;
	let taskState: TaskState | null = null;
	try {
		for await (const line of lines) {
			if (line.trim() === '') {
				continue;
			}
			lineNumber += 1;
			const parsedLine: unknown = JSON.parse(line);
			if (lineNumber === 1) {
				if (!isAcceptedTaskEventLogRecord(parsedLine)) {
					return null;
				}
				taskState = createInitialState(parsedLine.data.taskId, parsedLine.data.config);
				taskState = {
					...taskState,
					createdAt: parsedLine.ts,
					updatedAt: parsedLine.ts,
				};
				continue;
			}
			if (!taskState || !isTimestampedTaskEventLogRecord(parsedLine)) {
				return null;
			}
			taskState = applyEvent(taskState, parsedLine.data);
		}
		return taskState;
	} catch {
		return null;
	} finally {
		lines.close();
	}
}

async function readTaskAcceptedConfigFromEventLog(
	eventLogPath: string,
): Promise<TaskConfig | null> {
	try {
		const stat = await fs.lstat(eventLogPath);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			return null;
		}
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return null;
		}
		throw error;
	}

	const lines = createInterface({
		crlfDelay: Infinity,
		input: createReadStream(eventLogPath, { encoding: 'utf8' }),
	});
	try {
		for await (const line of lines) {
			if (line.trim() === '') {
				continue;
			}
			const parsedLine: unknown = JSON.parse(line);
			if (!isAcceptedTaskEventLogRecord(parsedLine)) {
				return null;
			}
			return parsedLine.data.config;
		}
		return null;
	} catch {
		return null;
	} finally {
		lines.close();
	}
}

export function classifyTaskLogForRecovery(
	events: readonly TaskLogEventForRecovery[],
): TaskLogRecoveryClassification {
	const firstEvent = events[0];
	if (!firstEvent || firstEvent.data.event !== 'task-accepted') {
		return 'unreadable';
	}

	const lastEvent = events[events.length - 1];
	if (lastEvent && terminalTaskEventNames.has(lastEvent.data.event)) {
		return 'terminal';
	}

	return 'needs-failure-event';
}

export async function classifyTaskEventLogForRecovery(
	eventLogPath: string,
): Promise<TaskLogRecoveryClassification> {
	try {
		if (!(await pathExists(eventLogPath))) {
			return (await pathExists(getTaskFailureSentinelPathForEventLog(eventLogPath)))
				? 'terminal'
				: 'unreadable';
		}
		const taskState = await loadTaskStateFromEventLogForRecovery(eventLogPath);
		if (!taskState) {
			return 'unreadable';
		}
		return isTerminal(taskState) ? 'terminal' : 'needs-failure-event';
	} catch {
		return 'unreadable';
	}
}

function isPathContainedBy(parentPath: string, childPath: string): boolean {
	const relativePath = path.relative(parentPath, childPath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function assertPathIsPlainDirectoryIfPresent(options: {
	readonly label: string;
	readonly parentRealPath: string;
	readonly targetPath: string;
}): Promise<readonly string[]> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(options.targetPath);
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return [];
		}
		throw error;
	}
	if (stat.isSymbolicLink()) {
		return [`${options.label} '${options.targetPath}' is a symbolic link; skipping cleanup.`];
	}
	if (!stat.isDirectory()) {
		return [`${options.label} '${options.targetPath}' is not a directory; skipping cleanup.`];
	}
	const targetRealPath = await fs.realpath(options.targetPath);
	if (!isPathContainedBy(options.parentRealPath, targetRealPath)) {
		return [
			`${options.label} '${options.targetPath}' resolves outside '${options.parentRealPath}'; skipping cleanup.`,
		];
	}
	return [];
}

async function validateTaskCleanupPaths(
	options: CleanupTaskRuntimeOptions,
): Promise<readonly string[]> {
	if (!workerTaskIdPattern.test(options.taskId)) {
		return [
			`Worker task id '${options.taskId}' is not a controller-generated UUID; skipping cleanup.`,
		];
	}

	const taskRoot = path.join(options.zone.gateway.stateDir, 'tasks', options.taskId);
	const tasksRoot = path.join(options.zone.gateway.stateDir, 'tasks');
	const runtimeZoneRoot = path.join(options.runtimeDir, 'worker-tasks', options.zone.id);
	const taskRuntimeRoot = path.join(runtimeZoneRoot, options.taskId);
	const taskRootWarnings = await assertPathIsPlainDirectoryIfPresent({
		label: 'Worker task root',
		parentRealPath: await fs.realpath(tasksRoot),
		targetPath: taskRoot,
	});
	if (taskRootWarnings.length > 0) {
		return taskRootWarnings;
	}

	const taskRootRealPath = await fs.realpath(taskRoot);
	const taskChildWarnings = (
		await Promise.all([
			assertPathIsPlainDirectoryIfPresent({
				label: 'Worker task state directory',
				parentRealPath: taskRootRealPath,
				targetPath: path.join(taskRoot, 'state'),
			}),
			assertPathIsPlainDirectoryIfPresent({
				label: 'Worker task state log directory',
				parentRealPath: taskRootRealPath,
				targetPath: path.join(taskRoot, 'state', 'tasks'),
			}),
			assertPathIsPlainDirectoryIfPresent({
				label: 'Worker task agent-vm directory',
				parentRealPath: taskRootRealPath,
				targetPath: path.join(taskRoot, 'agent-vm'),
			}),
			assertPathIsPlainDirectoryIfPresent({
				label: 'Worker task resources directory',
				parentRealPath: taskRootRealPath,
				targetPath: path.join(taskRoot, 'agent-vm', 'resources'),
			}),
		])
	).flat();
	if (taskChildWarnings.length > 0) {
		return taskChildWarnings;
	}

	if (!(await pathExists(runtimeZoneRoot))) {
		return [];
	}
	const runtimeZoneRootRealPath = await fs.realpath(runtimeZoneRoot);
	return (
		await Promise.all([
			assertPathIsPlainDirectoryIfPresent({
				label: 'Worker task runtime root',
				parentRealPath: runtimeZoneRootRealPath,
				targetPath: taskRuntimeRoot,
			}),
			assertPathIsPlainDirectoryIfPresent({
				label: 'Worker task repo metadata directory',
				parentRealPath: runtimeZoneRootRealPath,
				targetPath: path.join(taskRuntimeRoot, 'repo-metadata'),
			}),
		])
	).flat();
}

async function recoverStartedRepoResourceProviders(
	options: CleanupTaskRuntimeOptions,
): Promise<readonly StartedRepoResourceProvider[]> {
	const metadataRoot = path.join(
		options.runtimeDir,
		'worker-tasks',
		options.zone.id,
		options.taskId,
		'repo-metadata',
	);
	let entries: readonly Dirent[];
	try {
		entries = await fs.readdir(metadataRoot, { withFileTypes: true });
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return [];
		}
		throw error;
	}
	return (
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && repoIdPattern.test(entry.name))
				.map(async (entry) => {
					const repoDir = path.join(metadataRoot, entry.name);
					const composeFilePath = path.join(repoDir, '.agent-vm', 'docker-compose.yml');
					if (!(await pathExists(composeFilePath))) {
						return null;
					}
					return {
						composeFilePath,
						composeProjectName: buildRepoResourceProviderComposeProjectName(
							options.taskId,
							entry.name,
						),
						repoDir,
						repoId: entry.name,
					} satisfies StartedRepoResourceProvider;
				}),
		)
	).filter((provider): provider is StartedRepoResourceProvider => provider !== null);
}

async function cleanupTaskRuntime(
	options: CleanupTaskRuntimeOptions,
	dependencies: { readonly postStopGateway: PostStopGatewayFn },
): Promise<readonly string[]> {
	const safetyWarnings = await validateTaskCleanupPaths(options);
	if (safetyWarnings.length > 0) {
		return safetyWarnings;
	}
	const startedProviders = await recoverStartedRepoResourceProviders(options);
	await dependencies.postStopGateway(options.taskId, options.zone, startedProviders, {
		runtimeDir: options.runtimeDir,
	});
	return [];
}

async function quarantineEventLog(eventLogPath: string): Promise<void> {
	try {
		await fs.rename(eventLogPath, `${eventLogPath}.unreadable-${String(Date.now())}`);
	} catch (error) {
		if (!isNodeErrorWithCode(error, 'ENOENT')) {
			throw error;
		}
	}
}

async function markTaskFailed(options: {
	readonly dependencies: Required<
		Pick<
			WorkerTaskStartupRecoveryDependencies,
			'appendEvent' | 'quarantineEventLog' | 'readTaskAcceptedConfig' | 'writeFailureSentinel'
		>
	>;
	readonly eventLogPath: string;
	readonly classification: TaskLogRecoveryClassification;
	readonly stateDir: string;
	readonly taskId: string;
}): Promise<boolean> {
	if (options.classification === 'needs-failure-event') {
		await options.dependencies.appendEvent(options.eventLogPath, {
			event: 'task-failed',
			reason: workerTaskRestartFailureReason,
		});
		return true;
	}

	if (options.classification === 'unreadable') {
		const taskConfig = await options.dependencies.readTaskAcceptedConfig(options.eventLogPath);
		if (!taskConfig) {
			return false;
		}
		await options.dependencies.writeFailureSentinel({
			config: taskConfig,
			reason: workerTaskRestartFailureReason,
			stateDir: options.stateDir,
			taskId: options.taskId,
		});
		await options.dependencies.quarantineEventLog(options.eventLogPath);
		return true;
	}

	return false;
}

export async function recoverOrphanedWorkerTasksAtStartup(
	options: RecoverOrphanedWorkerTasksOptions,
	dependencies: WorkerTaskStartupRecoveryDependencies = {},
): Promise<WorkerTaskStartupRecoveryResult> {
	const classifyTaskEventLog =
		dependencies.classifyTaskEventLogForRecovery ?? classifyTaskEventLogForRecovery;
	const listTaskIds = dependencies.listTaskIds ?? listWorkerTaskIds;
	const cleanupRecoveredTaskRuntime =
		dependencies.cleanupTaskRuntime ??
		((cleanupOptions: CleanupTaskRuntimeOptions) =>
			cleanupTaskRuntime(cleanupOptions, {
				postStopGateway: dependencies.postStopGateway ?? postStopGateway,
			}));
	const recoveryDependencies = {
		appendEvent: dependencies.appendEvent ?? appendEvent,
		quarantineEventLog: dependencies.quarantineEventLog ?? quarantineEventLog,
		readTaskAcceptedConfig:
			dependencies.readTaskAcceptedConfig ?? readTaskAcceptedConfigFromEventLog,
		writeFailureSentinel: dependencies.writeFailureSentinel ?? writeTaskFailureSentinel,
	};
	const warnings: string[] = [];
	let recoveredCount = 0;
	const selectedZoneIds = options.zoneIds === undefined ? null : new Set(options.zoneIds);

	for (const zone of options.systemConfig.zones) {
		if (selectedZoneIds !== null && !selectedZoneIds.has(zone.id)) {
			continue;
		}
		if (zone.gateway.type !== 'worker') {
			continue;
		}

		let taskIds: readonly string[];
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop -- startup recovery stays sequential to keep filesystem cleanup bounded and warnings ordered per zone.
			taskIds = await listTaskIds(zone);
		} catch (error) {
			warnings.push(
				`Failed to list worker tasks for zone '${zone.id}': ${formatUnknownError(error)}`,
			);
			continue;
		}

		for (const taskId of taskIds) {
			const eventLogPath = getTaskEventLogPath(zone, taskId);
			const taskStateDir = getTaskStateDir(zone, taskId);
			let classification: TaskLogRecoveryClassification;
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- each task's marker and cleanup are serialized so recovery warnings stay tied to one task at a time.
				classification = await classifyTaskEventLog(eventLogPath);
			} catch (error) {
				classification = 'unreadable';
				warnings.push(
					`Failed to classify worker task '${taskId}' in zone '${zone.id}': ${formatUnknownError(error)}`,
				);
			}

			if (classification === 'terminal') {
				continue;
			}

			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- writing terminal state before cleanup preserves task visibility if cleanup fails.
				const recovered = await markTaskFailed({
					classification,
					dependencies: recoveryDependencies,
					eventLogPath,
					stateDir: taskStateDir,
					taskId,
				});
				if (!recovered) {
					warnings.push(
						`Unable to mark worker task '${taskId}' in zone '${zone.id}' failed because its event log is unreadable and no task-accepted config could be recovered.`,
					);
				} else {
					recoveredCount += 1;
					warnings.push(
						`Worker task '${taskId}' in zone '${zone.id}' was marked failed after controller restart, but the startup sweep cannot kill orphaned worker VM processes because worker VM runtime identities are not persisted across controller restarts.`,
					);
				}
			} catch (error) {
				warnings.push(
					`Failed to recover worker task '${taskId}' in zone '${zone.id}': ${formatUnknownError(error)}`,
				);
			}

			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- cleanup is best-effort and serialized to avoid concurrent removal of shared task roots.
				const cleanupWarnings = await cleanupRecoveredTaskRuntime({
					runtimeDir: options.systemConfig.runtimeDir,
					taskId,
					zone,
				});
				if (cleanupWarnings) {
					warnings.push(...cleanupWarnings);
				}
			} catch (error) {
				warnings.push(
					`Failed to prune rebuildable resources for worker task '${taskId}' in zone '${zone.id}': ${formatUnknownError(error)}`,
				);
			}
		}
	}

	return { recoveredCount, warnings };
}
