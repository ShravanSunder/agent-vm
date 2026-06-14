import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendEvent, workerConfigSchema, type TaskConfig } from '@agent-vm/agent-vm-worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import type { ControllerLeaseManager } from './http/controller-http-route-support.js';
import { createControllerService } from './http/controller-http-routes.js';
import { createTaskStateReader } from './task-state-reader.js';
import {
	recoverOrphanedWorkerTasksAtStartup,
	workerTaskRestartFailureReason,
} from './worker-task-startup-recovery.js';

let rootDir: string;

beforeEach(async () => {
	rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-task-startup-recovery-'));
});

afterEach(async () => {
	await fs.rm(rootDir, { recursive: true, force: true });
});

function makeMinimalTaskConfig(taskId: string): TaskConfig {
	return {
		taskId,
		prompt: 'recover me',
		repos: [],
		context: {},
		effectiveConfig: workerConfigSchema.parse({
			runtimeInstructions: 'Generated runtime instructions.',
			commonAgentInstructions: null,
			defaults: { provider: 'codex', model: 'latest-medium' },
			phases: {
				plan: {
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: null,
					reviewerInstructions: null,
					skills: [],
				},
				work: {
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: null,
					reviewerInstructions: null,
					skills: [],
				},
				wrapup: { instructions: null, skills: [] },
			},
		}),
	};
}

function makeSystemConfig(): SystemConfig {
	return {
		schemaVersion: 1,
		cacheDir: path.join(rootDir, 'cache'),
		runtimeDir: path.join(rootDir, 'runtime'),
		host: {
			controllerPort: 18800,
			projectNamespace: 'startup-recovery-tests',
		},
		imageProfiles: {
			gateways: {
				worker: { type: 'worker', buildConfig: path.join(rootDir, 'gateway-build.json') },
			},
			toolVms: {
				default: { type: 'toolVm', buildConfig: path.join(rootDir, 'tool-build.json') },
			},
		},
		zones: [
			{
				id: 'zone-1',
				gateway: {
					type: 'worker',
					imageProfile: 'worker',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: path.join(rootDir, 'worker-config.json'),
					stateDir: path.join(rootDir, 'state'),
				},
				secrets: {},
				egressHosts: [],
				websocketBypass: [],
			},
		],
		toolVmProfiles: {
			standard: { memory: '1G', cpus: 1, imageProfile: 'default' },
		},
		tcpPool: { basePort: 19000, size: 4 },
	};
}

function makeLoadedSystemConfig(): LoadedSystemConfig {
	return {
		...makeSystemConfig(),
		systemConfigPath: path.join(rootDir, 'config', 'system.jsonc'),
	};
}

function makeLeaseManagerStub(): ControllerLeaseManager {
	return {
		createLease: async () => {
			throw new Error('not used');
		},
		listLeases: () => [],
		peekLease: () => undefined,
		releaseLease: async () => {},
		renewLease: async () => {
			throw new Error('not used');
		},
	};
}

function getSystemConfigZone(systemConfig: SystemConfig): SystemConfig['zones'][number] {
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected test zone config.');
	}
	return zone;
}

function getTaskPaths(
	systemConfig: SystemConfig,
	taskId: string,
): {
	readonly eventLogPath: string;
	readonly taskRoot: string;
	readonly taskRuntimeRoot: string;
	readonly taskStateDir: string;
	readonly zone: SystemConfig['zones'][number];
} {
	const zone = getSystemConfigZone(systemConfig);
	const taskRoot = path.join(zone.gateway.stateDir, 'tasks', taskId);
	const taskStateDir = path.join(taskRoot, 'state');
	return {
		eventLogPath: path.join(taskStateDir, 'tasks', `${taskId}.jsonl`),
		taskRoot,
		taskRuntimeRoot: path.join(systemConfig.runtimeDir, 'worker-tasks', zone.id, taskId),
		taskStateDir,
		zone,
	};
}

async function writeAcceptedTaskEvent(eventLogPath: string, taskId: string): Promise<void> {
	await appendEvent(eventLogPath, {
		event: 'task-accepted',
		taskId,
		config: makeMinimalTaskConfig(taskId),
	});
}

describe('recoverOrphanedWorkerTasksAtStartup', () => {
	it('marks replayable non-terminal worker task logs failed and prunes rebuildable runtime paths', async () => {
		const systemConfig = makeSystemConfig();
		const taskId = '11111111-1111-4111-8111-111111111111';
		const { eventLogPath, taskRoot, taskRuntimeRoot, taskStateDir, zone } = getTaskPaths(
			systemConfig,
			taskId,
		);
		await writeAcceptedTaskEvent(eventLogPath, taskId);
		await appendEvent(eventLogPath, { event: 'phase-started', phase: 'work' });
		await fs.mkdir(path.join(taskRuntimeRoot, 'work'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'agent-vm', 'resources', 'repo-a'), { recursive: true });
		await fs.writeFile(path.join(taskRuntimeRoot, 'work', 'README.md'), 'runtime data');
		await fs.writeFile(
			path.join(taskRoot, 'agent-vm', 'resources', 'repo-a', 'mock.json'),
			'{"ok":true}\n',
		);

		const recoveryResult = await recoverOrphanedWorkerTasksAtStartup({ systemConfig });
		const recoveredState = await createTaskStateReader({ systemConfig }).read(zone.id, taskId);

		expect(recoveryResult.recoveredCount).toBe(1);
		expect(recoveryResult.warnings).toContainEqual(expect.stringContaining('worker VM'));
		expect(recoveredState?.status).toBe('failed');
		expect(recoveredState?.failureReason).toBe(workerTaskRestartFailureReason);
		await expect(fs.stat(taskStateDir)).resolves.toBeDefined();
		await expect(fs.stat(taskRuntimeRoot)).rejects.toThrow();
		await expect(fs.stat(path.join(taskRoot, 'agent-vm', 'resources'))).rejects.toThrow();
	});

	it('makes corrupt task logs user-visible through the task-state route by quarantining the bad log', async () => {
		const systemConfig = makeLoadedSystemConfig();
		const taskId = '22222222-2222-4222-8222-222222222222';
		const { eventLogPath, zone } = getTaskPaths(systemConfig, taskId);
		await writeAcceptedTaskEvent(eventLogPath, taskId);
		await fs.appendFile(eventLogPath, 'not-json\n', 'utf8');
		await appendEvent(eventLogPath, { event: 'phase-started', phase: 'work' });

		const firstRecoveryResult = await recoverOrphanedWorkerTasksAtStartup({ systemConfig });
		const secondRecoveryResult = await recoverOrphanedWorkerTasksAtStartup({ systemConfig });
		const app = createControllerService({
			leaseManager: makeLeaseManagerStub(),
			operations: {
				getTaskState: async (routeZoneId, routeTaskId) =>
					await createTaskStateReader({ systemConfig }).read(routeZoneId, routeTaskId),
			},
			systemConfig,
		});
		const response = await app.request(`/zones/${zone.id}/tasks/${taskId}`);

		expect(firstRecoveryResult.recoveredCount).toBe(1);
		expect(secondRecoveryResult.recoveredCount).toBe(0);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			failureReason: workerTaskRestartFailureReason,
			status: 'failed',
			taskId,
		});
		await expect(fs.stat(eventLogPath)).rejects.toThrow();
	});

	it('does not append after a truncated final log line', async () => {
		const systemConfig = makeSystemConfig();
		const taskId = '33333333-3333-4333-8333-333333333333';
		const { eventLogPath, zone } = getTaskPaths(systemConfig, taskId);
		await writeAcceptedTaskEvent(eventLogPath, taskId);
		await fs.appendFile(eventLogPath, '{"ts":', 'utf8');

		const recoveryResult = await recoverOrphanedWorkerTasksAtStartup({ systemConfig });
		const recoveredState = await createTaskStateReader({ systemConfig }).read(zone.id, taskId);

		expect(recoveryResult.recoveredCount).toBe(1);
		expect(recoveredState?.status).toBe('failed');
		expect(recoveredState?.failureReason).toBe(workerTaskRestartFailureReason);
		await expect(fs.stat(eventLogPath)).rejects.toThrow();
	});

	it('prunes rebuildable runtime paths even when no task-accepted config can be recovered', async () => {
		const systemConfig = makeSystemConfig();
		const taskId = '44444444-4444-4444-8444-444444444444';
		const { eventLogPath, taskRoot, taskRuntimeRoot } = getTaskPaths(systemConfig, taskId);
		await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
		await fs.writeFile(eventLogPath, 'not-json\n', 'utf8');
		await fs.mkdir(path.join(taskRuntimeRoot, 'work'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'agent-vm', 'resources', 'repo-a'), { recursive: true });

		const recoveryResult = await recoverOrphanedWorkerTasksAtStartup({ systemConfig });

		expect(recoveryResult.recoveredCount).toBe(0);
		expect(recoveryResult.warnings).toContainEqual(
			expect.stringContaining('no task-accepted config could be recovered'),
		);
		await expect(fs.stat(taskRuntimeRoot)).rejects.toThrow();
		await expect(fs.stat(path.join(taskRoot, 'agent-vm', 'resources'))).rejects.toThrow();
	});

	it('does not follow symlinked task cleanup paths outside the task root', async () => {
		const systemConfig = makeSystemConfig();
		const taskId = '55555555-5555-4555-8555-555555555555';
		const { eventLogPath, taskRoot, taskRuntimeRoot } = getTaskPaths(systemConfig, taskId);
		const externalAgentVmDir = path.join(rootDir, 'outside-agent-vm');
		const externalResourcesDir = path.join(externalAgentVmDir, 'resources');
		await writeAcceptedTaskEvent(eventLogPath, taskId);
		await appendEvent(eventLogPath, { event: 'phase-started', phase: 'work' });
		await fs.mkdir(path.join(taskRuntimeRoot, 'work'), { recursive: true });
		await fs.mkdir(externalResourcesDir, { recursive: true });
		await fs.writeFile(path.join(externalResourcesDir, 'keep.txt'), 'do not delete');
		await fs.symlink(externalAgentVmDir, path.join(taskRoot, 'agent-vm'));

		const recoveryResult = await recoverOrphanedWorkerTasksAtStartup({ systemConfig });

		expect(recoveryResult.warnings).toContainEqual(expect.stringContaining('symbolic link'));
		await expect(fs.stat(path.join(externalResourcesDir, 'keep.txt'))).resolves.toBeDefined();
	});
});
