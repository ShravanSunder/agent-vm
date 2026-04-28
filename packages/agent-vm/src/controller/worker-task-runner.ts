import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	appendEvent,
	computeTotalTaskTimeoutMs,
	resolveWorkerConfigInstructionReferences,
	workerConfigDraftSchema,
	workerConfigSchema,
	type TaskEvent,
	type WorkerConfig,
	type WorkerConfigDraft,
} from '@agent-vm/agent-vm-worker';
import type { SecretResolver } from '@agent-vm/gondolin-adapter';
import { execa } from 'execa';
import { z } from 'zod';

import {
	workerTaskResourcesSchema,
	workerTaskControllerRequestSchema,
	type WorkerTaskControllerRequest,
	type WorkerTaskControllerRequestInput,
} from '../config/resource-contracts/index.js';
import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type {
	GatewayManagedVmFactoryOptions,
	GatewayZone,
} from '../gateway/gateway-zone-support.js';
import {
	hasRepoResourceDescriptionContract,
	loadRepoResourceDescriptionContract,
} from '../resources/repo-resource-contract-loader.js';
import {
	startRepoResourceProviders,
	stopRepoResourceProviders,
	type StartedRepoResourceProvider,
} from '../resources/repo-resource-provider-runner.js';
import { compileResourceOverlay } from '../resources/resource-compiler.js';
import { resolveTaskResources } from '../resources/resource-resolver.js';
import type { ActiveWorkerTask } from './active-task-registry.js';
import { buildGithubAuthConfigArgs, scrubGithubTokenFromOutput } from './git-auth-support.js';
import {
	buildResolvedRuntimeResources,
	buildRuntimeInstructions,
} from './runtime-instructions-builder.js';
import { buildTaskConfigFromPreparedInput } from './task-config-builder.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
	if (Array.isArray(base) || Array.isArray(override)) {
		return override ?? base;
	}
	if (isPlainObject(base) && isPlainObject(override)) {
		const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
		const mergedEntries = [...keys].map((key) => [key, deepMerge(base[key], override[key])]);
		return Object.fromEntries(mergedEntries);
	}
	return override ?? base;
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

const taskStatusResponseSchema = z
	.object({
		status: z.string(),
	})
	.passthrough();
const GIT_CLONE_TIMEOUT_MS = 120_000;

async function readJsonObjectFile(
	filePath: string,
	options: { readonly missingValue: Record<string, unknown>; readonly label: string },
): Promise<Record<string, unknown>> {
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			throw new Error(`${options.label} must be a JSON object`);
		}
		return parsed;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return options.missingValue;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${options.label}: ${message}`, { cause: error });
	}
}

async function copyLocalWorkerTarballIfConfigured(stateDir: string): Promise<void> {
	const localWorkerTarballPath = process.env.AGENT_VM_WORKER_TARBALL_PATH;
	if (!localWorkerTarballPath) {
		return;
	}

	await fs.copyFile(localWorkerTarballPath, path.join(stateDir, 'agent-vm-worker.tgz'));
}

async function writeAgentRuntimeFiles(
	agentVmDir: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	await Promise.all(
		Object.entries(files).map(async ([relativePath, content]) => {
			const outputPath = path.join(agentVmDir, relativePath);
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			await fs.writeFile(outputPath, content, { encoding: 'utf8', mode: 0o644 });
		}),
	);
}

async function replaceRelativeSymlink(linkPath: string, target: string): Promise<void> {
	try {
		await fs.unlink(linkPath);
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
			throw error;
		}
	}
	await fs.symlink(target, linkPath);
}

export type WorkerTaskInput = WorkerTaskControllerRequestInput;

export interface PreStartResult {
	readonly taskId: string;
	readonly input: WorkerTaskControllerRequest;
	readonly taskRoot: string;
	readonly workspaceDir: string;
	readonly stateDir: string;
	readonly startedResourceProviders: readonly StartedRepoResourceProvider[];
	readonly environment: Record<string, string>;
	readonly tcpHosts: Record<string, string>;
	readonly vfsMounts: GatewayManagedVmFactoryOptions['vfsMounts'];
	readonly repos: readonly {
		readonly repoId: string;
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly hostWorkspacePath: string;
		readonly workspacePath: string;
	}[];
	readonly effectiveConfig: WorkerConfig;
}

function deriveRepoDirectoryName(repoUrl: string, usedNames: Set<string>): string {
	const cleanedUrl = repoUrl.replace(/\.git$/, '');
	const baseName = cleanedUrl.split('/').pop()?.trim() ?? 'repo';
	const sanitizedBaseName =
		baseName
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/gu, '-')
			.replace(/^-+|-+$/gu, '') || 'repo';
	let candidate = sanitizedBaseName;
	let counter = 2;
	while (usedNames.has(candidate)) {
		candidate = `${sanitizedBaseName}-${counter}`;
		counter += 1;
	}
	usedNames.add(candidate);
	return candidate;
}

export interface WorkerTaskResult {
	readonly taskId: string;
	readonly finalState: unknown;
	readonly taskRoot: string;
}

export async function preStartGateway(
	taskInput: WorkerTaskInput,
	zoneConfig: GatewayZone,
	options: { readonly githubToken?: string } = {},
): Promise<PreStartResult> {
	const parsedTaskInput = workerTaskControllerRequestSchema.parse(taskInput);
	const taskId = crypto.randomUUID();
	const taskRoot = path.join(zoneConfig.gateway.stateDir, 'tasks', taskId);
	const workspaceDir = path.join(taskRoot, 'workspace');
	const stateDir = path.join(taskRoot, 'state');
	const agentVmDir = path.join(taskRoot, 'agent-vm');

	let startedResourceProviders: readonly StartedRepoResourceProvider[] = [];
	try {
		await fs.mkdir(workspaceDir, { recursive: true });
		await fs.mkdir(stateDir, { recursive: true });
		await fs.mkdir(agentVmDir, { recursive: true });
		await copyLocalWorkerTarballIfConfigured(stateDir);

		const usedRepoNames = new Set<string>();
		const preparedRepoTargets = parsedTaskInput.repos.map((repo) => {
			const repoId = deriveRepoDirectoryName(repo.repoUrl, usedRepoNames);
			const repoWorkspaceDir = path.join(workspaceDir, repoId);
			return {
				...repo,
				repoId,
				hostWorkspacePath: repoWorkspaceDir,
				workspacePath: `/work/repos/${repoId}`,
			};
		});
		const cloneResults = await Promise.allSettled(
			preparedRepoTargets.map(async (repo) => {
				const authArgs = options.githubToken ? buildGithubAuthConfigArgs(options.githubToken) : [];
				const cloneArgs = [
					...authArgs,
					'clone',
					'--branch',
					repo.baseBranch,
					repo.repoUrl,
					repo.hostWorkspacePath,
				];
				let cloneResult: {
					readonly exitCode?: number;
					readonly stderr: string;
					readonly stdout: string;
				};
				try {
					cloneResult = await execa('git', cloneArgs, {
						reject: false,
						timeout: GIT_CLONE_TIMEOUT_MS,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(
						`git clone failed for ${repo.repoUrl}: ${scrubGithubTokenFromOutput(message)}`,
						{ cause: error },
					);
				}
				if ((cloneResult.exitCode ?? -1) !== 0) {
					const errorDetail = scrubGithubTokenFromOutput(
						`${cloneResult.stdout}\n${cloneResult.stderr}`.trim(),
					);
					throw new Error(`git clone failed for ${repo.repoUrl}: ${errorDetail}`.trim());
				}
				for (const [key, value] of [
					['user.email', 'agent-vm-worker@agent-vm'],
					['user.name', 'agent-vm-worker'],
					['http.version', 'HTTP/1.1'],
					['commit.gpgsign', 'false'],
				] as const) {
					// Git serializes config writes through .git/config.lock; keep these ordered.
					// oxlint-disable-next-line eslint/no-await-in-loop
					await execa('git', ['-C', repo.hostWorkspacePath, 'config', key, value], {
						reject: true,
						timeout: 10_000,
					});
				}
				return {
					repoId: repo.repoId,
					repoUrl: repo.repoUrl,
					baseBranch: repo.baseBranch,
					hostWorkspacePath: repo.hostWorkspacePath,
					workspacePath: repo.workspacePath,
				};
			}),
		);
		const rejectedCloneResult = cloneResults.find((result) => result.status === 'rejected');
		if (rejectedCloneResult) {
			throw rejectedCloneResult.reason;
		}
		const clonedRepos: {
			readonly repoId: string;
			readonly repoUrl: string;
			readonly baseBranch: string;
			readonly hostWorkspacePath: string;
			readonly workspacePath: string;
		}[] = cloneResults.map((result) => {
			if (result.status === 'rejected') {
				throw result.reason;
			}
			return result.value;
		});

		const primaryRepoWorkspaceDir = clonedRepos[0]?.hostWorkspacePath ?? workspaceDir;
		const projectConfigPath = path.join(primaryRepoWorkspaceDir, '.agent-vm', 'config.json');
		const projectConfig = await readJsonObjectFile(projectConfigPath, {
			label: 'project config',
			missingValue: {},
		});
		const baseConfig = await readJsonObjectFile(zoneConfig.gateway.config, {
			label: 'gateway config',
			missingValue: {},
		});
		const resolvedBaseConfig = await resolveWorkerConfigInstructionReferences(baseConfig, {
			configPath: zoneConfig.gateway.config,
		});
		const effectiveConfigDraft = workerConfigDraftSchema.parse(
			deepMerge(resolvedBaseConfig, projectConfig),
		) satisfies WorkerConfigDraft;

		const repoResourceDescriptions = await Promise.all(
			clonedRepos.map(async (repo) => ({
				repoId: repo.repoId,
				repoUrl: repo.repoUrl,
				hasContract: await hasRepoResourceDescriptionContract(repo.hostWorkspacePath),
				description: await loadRepoResourceDescriptionContract({
					repoDir: repo.hostWorkspacePath,
					repoId: repo.repoId,
					repoUrl: repo.repoUrl,
				}),
			})),
		);
		const resources = workerTaskResourcesSchema.parse(parsedTaskInput.resources);
		const resolvedResources = resolveTaskResources({
			allowRepoResources: zoneConfig.resources?.allowRepoResources ?? true,
			externalResources: resources.externalResources,
			repos: repoResourceDescriptions,
		});
		const repoById = new Map(clonedRepos.map((repo) => [repo.repoId, repo]));
		const providerRun = await startRepoResourceProviders({
			taskId,
			repos: repoResourceDescriptions
				.map((repoDescription) => {
					if (!repoDescription.hasContract) {
						return null;
					}
					const repo = repoById.get(repoDescription.repoId);
					if (!repo) {
						throw new Error(`Resource setup references unknown repo '${repoDescription.repoId}'.`);
					}
					return {
						repoId: repoDescription.repoId,
						repoUrl: repoDescription.repoUrl,
						repoDir: repo.hostWorkspacePath,
						outputDir: path.join(agentVmDir, 'resources', repoDescription.repoId),
						setupCommand: repoDescription.description.setupCommand,
					};
				})
				.filter(
					(
						repo,
					): repo is {
						readonly repoId: string;
						readonly repoUrl: string;
						readonly repoDir: string;
						readonly outputDir: string;
						readonly setupCommand: string;
					} => repo !== null,
				),
			providers: resolvedResources.selectedRepoProviders.map((provider) => {
				const repo = repoById.get(provider.repoId);
				if (!repo) {
					throw new Error(
						`Resolved resource provider references unknown repo '${provider.repoId}'.`,
					);
				}
				return {
					...provider,
					repoDir: repo.hostWorkspacePath,
					outputDir: path.join(agentVmDir, 'resources', provider.repoId),
				};
			}),
		});
		startedResourceProviders = providerRun.startedProviders;
		const overlay = compileResourceOverlay({
			externalResources: resolvedResources.externalResources,
			repoFinalizations: providerRun.finalizations,
		});
		const runtime = buildRuntimeInstructions({
			resolvedResources: buildResolvedRuntimeResources({
				externalResources: resolvedResources.externalResources,
				repoFinalizations: providerRun.finalizations,
			}),
			runtimeAuthHints: zoneConfig.runtimeAuthHints ?? [],
			taskId,
			workspaceDir: '/work/repos',
		});
		const effectiveConfig = workerConfigSchema.parse({
			...effectiveConfigDraft,
			runtimeInstructions: runtime.runtimeInstructions,
		}) satisfies WorkerConfig;
		await writeAgentRuntimeFiles(agentVmDir, runtime.agentRuntimeFiles);
		await replaceRelativeSymlink(path.join(agentVmDir, 'CLAUDE.md'), 'agents.md');
		await fs.writeFile(path.join(workspaceDir, 'AGENTS.md'), runtime.workspaceAgentsMd, {
			encoding: 'utf8',
			mode: 0o644,
		});
		await replaceRelativeSymlink(path.join(workspaceDir, 'CLAUDE.md'), 'AGENTS.md');
		await fs.writeFile(
			path.join(stateDir, 'effective-worker.json'),
			JSON.stringify(effectiveConfig, null, 2),
			{ encoding: 'utf8', mode: 0o600 },
		);

		return {
			taskId,
			input: parsedTaskInput,
			taskRoot,
			workspaceDir,
			stateDir,
			startedResourceProviders: providerRun.startedProviders,
			environment: overlay.environment,
			tcpHosts: overlay.tcpHosts,
			vfsMounts: {
				'/work/repos': {
					hostPath: workspaceDir,
					kind: 'realfs',
				},
				'/agent-vm': {
					hostPath: agentVmDir,
					kind: 'realfs-readonly',
				},
			},
			repos: clonedRepos,
			effectiveConfig,
		};
	} catch (error) {
		return await cleanupTaskRootAfterPreparationFailure({
			primaryError: error,
			startedProviders: startedResourceProviders,
			taskId,
			taskRoot,
		});
	}
}

export async function postStopGateway(
	taskId: string,
	zoneConfig: GatewayZone,
	startedProviders: readonly StartedRepoResourceProvider[] = [],
): Promise<void> {
	const taskRoot = path.join(zoneConfig.gateway.stateDir, 'tasks', taskId);
	const workspaceDir = path.join(taskRoot, 'workspace');
	const resourcesDir = path.join(taskRoot, 'agent-vm', 'resources');
	let cleanupError: Error | null = null;
	let workspaceRemovalError: Error | null = null;
	let resourcesRemovalError: Error | null = null;
	try {
		await stopRepoResourceProviders(startedProviders);
	} catch (error) {
		cleanupError = error instanceof Error ? error : new Error(String(error));
	}
	try {
		await fs.rm(resourcesDir, { recursive: true, force: true });
	} catch (error) {
		resourcesRemovalError = error instanceof Error ? error : new Error(String(error));
	}
	try {
		await fs.rm(workspaceDir, { recursive: true, force: true });
	} catch (error) {
		workspaceRemovalError = error instanceof Error ? error : new Error(String(error));
	}
	const errors = [cleanupError, resourcesRemovalError, workspaceRemovalError].filter(
		(error): error is Error => error !== null,
	);
	if (errors.length > 1) {
		const aggregateError = new AggregateError(
			errors,
			`Failed to stop Docker services and prune task resources/workspace for ${taskId}.`,
		);
		aggregateError.cause = errors[0];
		throw aggregateError;
	}
	if (errors.length === 1) {
		throw errors[0];
	}
}

async function cleanupTaskRootAfterPreparationFailure(options: {
	readonly primaryError: unknown;
	readonly startedProviders: readonly StartedRepoResourceProvider[];
	readonly taskId: string;
	readonly taskRoot: string;
}): Promise<never> {
	const errors = [toError(options.primaryError)];
	try {
		await stopRepoResourceProviders(options.startedProviders);
	} catch (cleanupError) {
		errors.push(toError(cleanupError));
	}
	try {
		await fs.rm(options.taskRoot, { recursive: true, force: true });
	} catch (removeError) {
		errors.push(toError(removeError));
	}
	if (errors.length === 1) {
		throw errors[0];
	}
	const aggregateError = new AggregateError(
		errors,
		`Failed to clean up task ${options.taskId} after preparation failure.`,
	);
	aggregateError.cause = errors[0];
	throw aggregateError;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const responseBody = await response.text();
		throw new Error(
			`${init?.method ?? 'GET'} ${url} failed with ${String(response.status)}: ${responseBody}`,
		);
	}
	return await response.json();
}

export interface PreparedWorkerTask {
	readonly taskId: string;
	readonly taskRoot: string;
	readonly zoneId: string;
	readonly input: WorkerTaskControllerRequest;
	readonly preStartResult: PreStartResult;
	readonly taskZoneConfig: GatewayZone;
	readonly zone: GatewayZone;
	readonly eventLogPath: string;
	readonly recordEvent: (event: TaskEvent) => Promise<void>;
}

export interface PrepareWorkerTaskOptions {
	readonly input: WorkerTaskInput;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
	readonly githubToken?: string;
	readonly onTaskPrepared?: (task: ActiveWorkerTask) => void | Promise<void>;
}

export interface ExecuteWorkerTaskOptions {
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly timeoutMs?: number;
	readonly onWorkerTaskIngress?: (
		zoneId: string,
		taskId: string,
		workerIngress: { readonly host: string; readonly port: number },
	) => void | Promise<void>;
	readonly onTaskFinished?: (zoneId: string, taskId: string) => void | Promise<void>;
}

export async function prepareWorkerTask(
	options: PrepareWorkerTaskOptions,
): Promise<PreparedWorkerTask> {
	const zone = options.systemConfig.zones.find(
		(candidateZone) => candidateZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}
	if (zone.gateway.type !== 'worker') {
		throw new Error(`Zone '${options.zoneId}' is not a worker zone.`);
	}

	const preStartOptions = options.githubToken ? { githubToken: options.githubToken } : {};
	const preStartResult = await preStartGateway(options.input, zone, preStartOptions);
	const parsedInput = preStartResult.input;
	try {
		const taskZoneConfig: GatewayZone = {
			...zone,
			gateway: {
				...zone.gateway,
				stateDir: preStartResult.stateDir,
			},
		};

		const eventLogPath = path.join(
			preStartResult.stateDir,
			'tasks',
			`${preStartResult.taskId}.jsonl`,
		);
		const recordEvent = async (event: TaskEvent): Promise<void> => {
			await appendEvent(eventLogPath, event);
		};
		await recordEvent({
			event: 'task-accepted',
			taskId: preStartResult.taskId,
			config: buildTaskConfigFromPreparedInput({
				taskId: preStartResult.taskId,
				input: parsedInput,
				repos: preStartResult.repos,
				effectiveConfig: preStartResult.effectiveConfig,
			}),
		});

		await options.onTaskPrepared?.({
			taskId: preStartResult.taskId,
			zoneId: options.zoneId,
			taskRoot: preStartResult.taskRoot,
			branchPrefix: preStartResult.effectiveConfig.branchPrefix,
			repos: preStartResult.repos.map((repo) => ({
				repoUrl: repo.repoUrl,
				baseBranch: repo.baseBranch,
				hostGitDir: path.join(repo.hostWorkspacePath, '.git'),
				vmWorkspacePath: repo.workspacePath,
			})),
			workerIngress: null,
		});

		return {
			taskId: preStartResult.taskId,
			taskRoot: preStartResult.taskRoot,
			zoneId: options.zoneId,
			input: parsedInput,
			preStartResult,
			taskZoneConfig,
			zone,
			eventLogPath,
			recordEvent,
		};
	} catch (error) {
		return await cleanupTaskRootAfterPreparationFailure({
			primaryError: error,
			startedProviders: preStartResult.startedResourceProviders,
			taskId: preStartResult.taskId,
			taskRoot: preStartResult.taskRoot,
		});
	}
}

export async function executeWorkerTask(
	prepared: PreparedWorkerTask,
	options: ExecuteWorkerTaskOptions,
): Promise<WorkerTaskResult> {
	let gateway: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
	let result: WorkerTaskResult | undefined;
	let primaryError: Error | undefined;

	try {
		gateway = await startGatewayZone({
			environmentOverride: prepared.preStartResult.environment,
			secretResolver: options.secretResolver,
			systemConfig: options.systemConfig,
			tcpHostsOverride: prepared.preStartResult.tcpHosts,
			vfsMountsOverride: prepared.preStartResult.vfsMounts,
			zoneId: prepared.zoneId,
			zoneOverride: prepared.taskZoneConfig,
		});
		await options.onWorkerTaskIngress?.(prepared.zoneId, prepared.taskId, gateway.ingress);

		const baseUrl = `http://${gateway.ingress.host}:${gateway.ingress.port}`;
		await fetchJson(`${baseUrl}/tasks`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				taskId: prepared.taskId,
				prompt: prepared.input.prompt,
				repos: prepared.preStartResult.repos.map((repo) => ({
					repoUrl: repo.repoUrl,
					baseBranch: repo.baseBranch,
					workspacePath: repo.workspacePath,
				})),
				context: prepared.input.context,
			}),
		});

		const timeoutMs =
			options.timeoutMs ?? computeTotalTaskTimeoutMs(prepared.preStartResult.effectiveConfig);
		const start = Date.now();
		let consecutivePollFailures = 0;
		while (Date.now() - start < timeoutMs) {
			let state:
				| {
						readonly status?: string | undefined;
				  }
				| undefined;
			try {
				// Polling task state is intentionally sequential because each request depends on prior status.
				// oxlint-disable-next-line eslint/no-await-in-loop
				const response = await fetchJson(`${baseUrl}/tasks/${prepared.taskId}`);
				state = taskStatusResponseSchema.parse(response);
				consecutivePollFailures = 0;
			} catch (error) {
				if (error instanceof z.ZodError) {
					throw new Error(
						`Worker task status response did not match the expected schema for task ${prepared.taskId}.`,
						{ cause: error },
					);
				}
				consecutivePollFailures += 1;
				const message = error instanceof Error ? error.message : String(error);
				writeStderr(
					`[worker-task-runner] Poll failure ${consecutivePollFailures} for task ${prepared.taskId}: ${message}`,
				);
				if (consecutivePollFailures >= 3) {
					throw new Error(
						`Worker task status polling failed ${String(consecutivePollFailures)} consecutive times for task ${prepared.taskId}; last error: ${message}`,
						{ cause: error },
					);
				}
			}
			if (!state) {
				// Poll retry loop intentionally sleeps before the next serial attempt.
				// oxlint-disable-next-line eslint/no-await-in-loop
				await new Promise((resolve) => setTimeout(resolve, 1000));
				continue;
			}
			if (state.status === 'completed' || state.status === 'failed' || state.status === 'closed') {
				result = {
					taskId: prepared.taskId,
					finalState: state,
					taskRoot: prepared.taskRoot,
				};
				break;
			}
			// The sleep is part of the serial poll loop and cannot be parallelized.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		if (!result) {
			throw new Error(`Worker task timed out after ${timeoutMs}ms.`);
		}
	} catch (error) {
		primaryError = toError(error);
	}

	const cleanupErrors: Error[] = [];
	try {
		await gateway?.vm.close();
	} catch (error) {
		cleanupErrors.push(toError(error));
	}
	try {
		await postStopGateway(
			prepared.taskId,
			prepared.zone,
			prepared.preStartResult.startedResourceProviders,
		);
	} catch (error) {
		cleanupErrors.push(toError(error));
	}
	try {
		await options.onTaskFinished?.(prepared.zoneId, prepared.taskId);
	} catch (error) {
		cleanupErrors.push(toError(error));
	}

	if (primaryError) {
		if (cleanupErrors.length > 0) {
			const aggregateError = new AggregateError(
				[primaryError, ...cleanupErrors],
				`Worker task ${prepared.taskId} failed; cleanup also failed.`,
			);
			aggregateError.cause = primaryError;
			throw aggregateError;
		}
		throw primaryError;
	}
	if (cleanupErrors.length === 1) {
		throw cleanupErrors[0];
	}
	if (cleanupErrors.length > 1) {
		const aggregateError = new AggregateError(
			cleanupErrors,
			`Failed to clean up worker task ${prepared.taskId}.`,
		);
		aggregateError.cause = cleanupErrors[0];
		throw aggregateError;
	}
	if (!result) {
		throw new Error(`Worker task ${prepared.taskId} exited without a terminal result.`);
	}
	return result;
}
