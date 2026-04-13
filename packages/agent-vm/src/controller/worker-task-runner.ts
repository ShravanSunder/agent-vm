import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { workerConfigSchema, type WorkerConfig } from 'agent-vm-worker';
import type { SecretResolver } from 'gondolin-core';

import type { SystemConfig } from '../config/system-config.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { GatewayZone } from '../gateway/gateway-zone-support.js';

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
	readonly repo?: { readonly repoUrl: string; readonly baseBranch: string } | null;
	readonly context: Record<string, unknown>;
}

export interface PreStartResult {
	readonly taskId: string;
	readonly taskRoot: string;
	readonly workspaceDir: string;
	readonly stateDir: string;
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

	await fs.mkdir(workspaceDir, { recursive: true });
	await fs.mkdir(stateDir, { recursive: true });

	if (taskInput.repo) {
		const cloneArgs = [
			'clone',
			'--branch',
			taskInput.repo.baseBranch,
			taskInput.repo.repoUrl,
			workspaceDir,
		];
		const { execa } = await import('execa');
		await execa('git', cloneArgs);
	}

	const projectConfigPath = path.join(workspaceDir, '.agent-vm', 'config.json');
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

	return { taskId, taskRoot, workspaceDir, stateDir };
}

export async function postStopGateway(taskId: string, zoneConfig: GatewayZone): Promise<void> {
	const taskRoot = path.join(zoneConfig.gateway.stateDir, 'tasks', taskId);
	await fs.rm(taskRoot, { recursive: true, force: true });
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
				repo: options.input.repo
					? {
							repoUrl: options.input.repo.repoUrl,
							baseBranch: options.input.repo.baseBranch,
							workspacePath: '/workspace',
						}
					: null,
				context: options.input.context,
			}),
		});

		const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
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
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		throw new Error(`Worker task timed out after ${timeoutMs}ms.`);
	} finally {
		try {
			await gateway?.vm.close();
		} finally {
			await postStopGateway(preStartResult.taskId, zone);
		}
	}
}
