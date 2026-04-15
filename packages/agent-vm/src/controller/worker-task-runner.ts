import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { workerConfigSchema, type WorkerConfig } from '@shravansunder/agent-vm-worker';
import type { SecretResolver } from '@shravansunder/gondolin-core';
import { execa } from 'execa';
import { z } from 'zod';

import type { SystemConfig } from '../config/system-config.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { GatewayZone } from '../gateway/gateway-zone-support.js';
import {
	DockerServiceRoutingError,
	startDockerServicesForTask,
	stopDockerServicesForTask,
} from './docker-service-routing.js';

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

const taskStatusResponseSchema = z
	.object({
		status: z.string(),
	})
	.passthrough();

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

export interface WorkerTaskInput {
	readonly prompt: string;
	readonly repos: readonly { readonly repoUrl: string; readonly baseBranch: string }[];
	readonly context: Record<string, unknown>;
}

export interface PreStartResult {
	readonly taskId: string;
	readonly taskRoot: string;
	readonly workspaceDir: string;
	readonly stateDir: string;
	readonly composeFilePaths: readonly string[];
	readonly tcpHosts: Record<string, string>;
	readonly repos: readonly {
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly workspacePath: string;
	}[];
}

function deriveRepoDirectoryName(repoUrl: string, usedNames: Set<string>): string {
	const cleanedUrl = repoUrl.replace(/\.git$/, '');
	const baseName = cleanedUrl.split('/').pop()?.trim() ?? 'repo';
	const sanitizedBaseName = baseName.replace(/[^a-zA-Z0-9._-]/g, '-');
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
): Promise<PreStartResult> {
	const taskId = crypto.randomUUID();
	const taskRoot = path.join(zoneConfig.gateway.stateDir, 'tasks', taskId);
	const workspaceDir = path.join(taskRoot, 'workspace');
	const stateDir = path.join(taskRoot, 'state');

	let composeFilePaths: readonly string[] = [];
	await fs.mkdir(workspaceDir, { recursive: true });
	await fs.mkdir(stateDir, { recursive: true });
	await copyLocalWorkerTarballIfConfigured(stateDir);

	try {
		const usedRepoNames = new Set<string>();
		const clonedRepoHostDirs: string[] = [];
		const clonedRepos: {
			readonly repoUrl: string;
			readonly baseBranch: string;
			readonly workspacePath: string;
		}[] = [];
		for (const repo of taskInput.repos) {
			const repoDirectoryName = deriveRepoDirectoryName(repo.repoUrl, usedRepoNames);
			const repoWorkspaceDir = path.join(workspaceDir, repoDirectoryName);
			const cloneArgs = ['clone', '--branch', repo.baseBranch, repo.repoUrl, repoWorkspaceDir];
			// Repo cloning is intentionally sequential to keep host-side side effects easy to reason about.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await execa('git', cloneArgs);
			clonedRepoHostDirs.push(repoWorkspaceDir);
			clonedRepos.push({
				repoUrl: repo.repoUrl,
				baseBranch: repo.baseBranch,
				workspacePath: `/workspace/${repoDirectoryName}`,
			});
		}

		const primaryRepoWorkspaceDir = clonedRepoHostDirs[0] ?? workspaceDir;
		const projectConfigPath = path.join(primaryRepoWorkspaceDir, '.agent-vm', 'config.json');
		const projectConfig = await readJsonObjectFile(projectConfigPath, {
			label: 'project config',
			missingValue: {},
		});
		const baseConfig = await readJsonObjectFile(zoneConfig.gateway.gatewayConfig, {
			label: 'gateway config',
			missingValue: {},
		});
		const effectiveConfig = workerConfigSchema.parse(
			deepMerge(baseConfig, projectConfig),
		) satisfies WorkerConfig;

		await fs.writeFile(
			path.join(stateDir, 'effective-worker.json'),
			JSON.stringify(effectiveConfig, null, 2),
			{ encoding: 'utf8', mode: 0o600 },
		);

		const dockerRouting = await startDockerServicesForTask(workspaceDir, clonedRepoHostDirs);
		composeFilePaths = dockerRouting.composeFilePaths;

		return {
			taskId,
			taskRoot,
			workspaceDir,
			stateDir,
			composeFilePaths,
			tcpHosts: dockerRouting.tcpHosts,
			repos: clonedRepos,
		};
	} catch (error) {
		const composeFilesToStop =
			error instanceof DockerServiceRoutingError ? error.startedComposeFilePaths : composeFilePaths;
		try {
			await stopDockerServicesForTask(composeFilesToStop);
		} finally {
			await fs.rm(taskRoot, { recursive: true, force: true });
		}
		throw error;
	}
}

export async function postStopGateway(
	taskId: string,
	zoneConfig: GatewayZone,
	composeFilePaths: readonly string[] = [],
): Promise<void> {
	const taskRoot = path.join(zoneConfig.gateway.stateDir, 'tasks', taskId);
	const workspaceDir = path.join(taskRoot, 'workspace');
	let cleanupError: Error | null = null;
	let workspaceRemovalError: Error | null = null;
	try {
		await stopDockerServicesForTask(composeFilePaths);
	} catch (error) {
		cleanupError = error instanceof Error ? error : new Error(String(error));
	}
	try {
		await fs.rm(workspaceDir, { recursive: true, force: true });
	} catch (error) {
		workspaceRemovalError = error instanceof Error ? error : new Error(String(error));
	}
	if (cleanupError && workspaceRemovalError) {
		throw new AggregateError(
			[cleanupError, workspaceRemovalError],
			`Failed to stop Docker services and prune the task workspace for ${taskId}.`,
		);
	}
	if (cleanupError) {
		throw cleanupError;
	}
	if (workspaceRemovalError) {
		throw workspaceRemovalError;
	}
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`${init?.method ?? 'GET'} ${url} failed with ${response.status}`);
	}
	return await response.json();
}

export async function runWorkerTask(options: {
	readonly input: WorkerTaskInput;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
	readonly timeoutMs?: number;
}): Promise<WorkerTaskResult> {
	const zone = options.systemConfig.zones.find(
		(candidateZone) => candidateZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}
	if (zone.gateway.type !== 'worker') {
		throw new Error(`Zone '${options.zoneId}' is not a worker zone.`);
	}

	const preStartResult = await preStartGateway(options.input, zone);
	const taskZoneConfig: GatewayZone = {
		...zone,
		gateway: {
			...zone.gateway,
			workspaceDir: preStartResult.workspaceDir,
			stateDir: preStartResult.stateDir,
		},
	};

	let gateway: Awaited<ReturnType<typeof startGatewayZone>> | undefined;

	try {
		gateway = await startGatewayZone({
			secretResolver: options.secretResolver,
			systemConfig: options.systemConfig,
			tcpHostsOverride: preStartResult.tcpHosts,
			zoneId: options.zoneId,
			zoneOverride: taskZoneConfig,
		});

		const baseUrl = `http://${gateway.ingress.host}:${gateway.ingress.port}`;
		await fetchJson(`${baseUrl}/tasks`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				taskId: preStartResult.taskId,
				prompt: options.input.prompt,
				repos: preStartResult.repos,
				context: options.input.context,
			}),
		});

		const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
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
				const response = await fetchJson(`${baseUrl}/tasks/${preStartResult.taskId}`);
				state = taskStatusResponseSchema.parse(response);
				consecutivePollFailures = 0;
			} catch (error) {
				if (error instanceof z.ZodError) {
					throw new Error(
						`Worker task status response did not match the expected schema for task ${preStartResult.taskId}.`,
						{ cause: error },
					);
				}
				consecutivePollFailures += 1;
				const message = error instanceof Error ? error.message : String(error);
				writeStderr(
					`[worker-task-runner] Poll failure ${consecutivePollFailures} for task ${preStartResult.taskId}: ${message}`,
				);
				if (consecutivePollFailures >= 3) {
					throw error;
				}
			}
			if (!state) {
				// Poll retry loop intentionally sleeps before the next serial attempt.
				// oxlint-disable-next-line eslint/no-await-in-loop
				await new Promise((resolve) => setTimeout(resolve, 1000));
				continue;
			}
			if (state.status === 'completed' || state.status === 'failed' || state.status === 'closed') {
				return {
					taskId: preStartResult.taskId,
					finalState: state,
					taskRoot: preStartResult.taskRoot,
				};
			}
			// The sleep is part of the serial poll loop and cannot be parallelized.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		throw new Error(`Worker task timed out after ${timeoutMs}ms.`);
	} finally {
		try {
			await gateway?.vm.close();
		} finally {
			await postStopGateway(preStartResult.taskId, zone, preStartResult.composeFilePaths);
		}
	}
}
