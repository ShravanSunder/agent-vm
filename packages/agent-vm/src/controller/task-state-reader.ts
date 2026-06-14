import fs from 'node:fs/promises';
import { join } from 'node:path';

import {
	applyEvent,
	createInitialState,
	loadTaskStateFromLog,
	type TaskConfig,
	type TaskState,
} from '@agent-vm/agent-vm-worker';

import type { SystemConfig } from '../config/system-config.js';

export interface TaskStateReader {
	readonly read: (zoneId: string, taskId: string) => Promise<TaskState | null>;
}

export interface CreateTaskStateReaderOptions {
	readonly systemConfig: SystemConfig;
}

export interface WriteTaskFailureSentinelOptions {
	readonly config: TaskConfig;
	readonly reason: string;
	readonly stateDir: string;
	readonly taskId: string;
}

export interface TaskStatePaths {
	readonly eventLogPath: string;
	readonly failureSentinelPath: string;
	readonly taskStateDir: string;
}

function writeTaskStateReaderLog(message: string): void {
	process.stderr.write(`[task-state-reader] ${message}\n`);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === code
	);
}

export function getTaskFailureSentinelPath(stateDir: string, taskId: string): string {
	return join(stateDir, 'tasks', `${taskId}.failed`);
}

function isTaskState(value: unknown): value is TaskState {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	return (
		typeof Reflect.get(value, 'taskId') === 'string' &&
		typeof Reflect.get(value, 'status') === 'string'
	);
}

export async function readTaskFailureSentinelPath(sentinelPath: string): Promise<TaskState | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(sentinelPath, 'utf8'));
		if (!isTaskState(parsed)) {
			throw new Error(`Task failure sentinel ${sentinelPath} is not a valid task state.`);
		}
		return parsed;
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		writeTaskStateReaderLog(`Unable to read task failure sentinel ${sentinelPath}: ${message}`);
		throw error;
	}
}

export async function readTaskFailureSentinel(
	stateDir: string,
	taskId: string,
): Promise<TaskState | null> {
	return await readTaskFailureSentinelPath(getTaskFailureSentinelPath(stateDir, taskId));
}

export async function writeTaskFailureSentinel(
	options: WriteTaskFailureSentinelOptions,
): Promise<void> {
	const sentinelPath = getTaskFailureSentinelPath(options.stateDir, options.taskId);
	const failedState = applyEvent(createInitialState(options.taskId, options.config), {
		event: 'task-failed',
		reason: options.reason,
	});
	await fs.mkdir(join(options.stateDir, 'tasks'), { recursive: true });
	await fs.writeFile(sentinelPath, JSON.stringify(failedState, null, 2), {
		encoding: 'utf8',
		mode: 0o600,
	});
}

export function resolveTaskStatePaths(options: {
	readonly systemConfig: SystemConfig;
	readonly taskId: string;
	readonly zoneId: string;
}): TaskStatePaths | null {
	const zone = options.systemConfig.zones.find((candidate) => candidate.id === options.zoneId);
	if (!zone) {
		return null;
	}
	const taskStateDir = join(zone.gateway.stateDir, 'tasks', options.taskId, 'state');
	return {
		eventLogPath: join(taskStateDir, 'tasks', `${options.taskId}.jsonl`),
		failureSentinelPath: getTaskFailureSentinelPath(taskStateDir, options.taskId),
		taskStateDir,
	};
}

export function createTaskStateReader(options: CreateTaskStateReaderOptions): TaskStateReader {
	return {
		read: async (zoneId, taskId) => {
			const paths = resolveTaskStatePaths({
				systemConfig: options.systemConfig,
				taskId,
				zoneId,
			});
			if (!paths) {
				return null;
			}
			try {
				await fs.access(paths.eventLogPath);
			} catch (error) {
				if (isNodeErrorWithCode(error, 'ENOENT')) {
					return await readTaskFailureSentinelPath(paths.failureSentinelPath);
				}
				const message = error instanceof Error ? error.message : String(error);
				writeTaskStateReaderLog(
					`Unable to access task state log ${paths.eventLogPath}: ${message}`,
				);
				throw error;
			}
			const state = await loadTaskStateFromLog(paths.eventLogPath);
			if (!state) {
				const sentinelState = await readTaskFailureSentinelPath(paths.failureSentinelPath);
				if (sentinelState) {
					return sentinelState;
				}
				const message = `Task state log ${paths.eventLogPath} is empty or does not begin with task-accepted.`;
				writeTaskStateReaderLog(message);
				throw new Error(message);
			}
			return state;
		},
	};
}
