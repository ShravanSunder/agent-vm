import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { workerConfigSchema, type WorkerConfig } from 'agent-vm-worker';
import type { SecretResolver } from 'gondolin-core';

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
	const baseName = cleanedUrl.split('/').pop()?.trim() || 'repo';
	let candidate = baseName.replace(/[^a-zA-Z0-9._-]/g, '-');
	let counter = 2;
	while (usedNames.has(candidate)) {
		candidate = `${baseName}-${counter}`;
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
			const { execa } = await import('execa');
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
		const projectConfig = await fs
			.readFile(projectConfigPath, 'utf8')
			.then((raw) => JSON.parse(raw) as Record<string, unknown>)
			.catch(() => ({}));
		const baseConfig = JSON.parse(
			await fs.readFile(zoneConfig.gateway.gatewayConfig, 'utf8'),
		) as Record<string, unknown>;
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
	let cleanupError: unknown = null;
	try {
		await stopDockerServicesForTask(composeFilePaths);
	} catch (error) {
		cleanupError = error;
	} finally {
		await fs.rm(taskRoot, { recursive: true, force: true });
	}
	if (cleanupError) {
		throw cleanupError;
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
	if (zone.gateway.type !== 'coding') {
		throw new Error(`Zone '${options.zoneId}' is not a coding zone.`);
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
		while (Date.now() - start < timeoutMs) {
			// Polling task state is intentionally sequential because each request depends on prior status.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const state = (await fetchJson(`${baseUrl}/tasks/${preStartResult.taskId}`)) as {
				readonly status?: string;
			};
			if (state.status === 'completed' || state.status === 'failed') {
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
