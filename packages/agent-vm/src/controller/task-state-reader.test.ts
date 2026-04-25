import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendEvent, workerConfigSchema, type TaskConfig } from '@agent-vm/agent-vm-worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { createTaskStateReader, writeTaskFailureSentinel } from './task-state-reader.js';

let stateDir: string;

beforeEach(async () => {
	stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-state-reader-'));
});

afterEach(async () => {
	await fs.rm(stateDir, { recursive: true, force: true });
});

function makeSystemConfig(): SystemConfig {
	return {
		cacheDir: '/tmp/cache',
		host: {
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
		},
		imageProfiles: {
			gateways: {
				worker: { type: 'worker', buildConfig: '/tmp/gateway-build.json' },
			},
			toolVms: {
				default: { type: 'toolVm', buildConfig: '/tmp/tool-build.json' },
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
					config: '/tmp/gateway-config.json',
					stateDir,
					workspaceDir: '/tmp/workspace',
				},
				secrets: {},
				allowedHosts: ['github.com'],
				websocketBypass: [],
				toolProfile: 'standard',
			},
		],
		toolProfiles: {
			standard: { memory: '1G', cpus: 1, workspaceRoot: '/tmp/tools', imageProfile: 'default' },
		},
		tcpPool: { basePort: 19000, size: 4 },
	};
}

function makeMinimalTaskConfig(taskId: string): TaskConfig {
	return {
		taskId,
		prompt: 'hello',
		repos: [],
		context: {},
		effectiveConfig: workerConfigSchema.parse({
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

describe('createTaskStateReader', () => {
	it('returns null for an unknown task', async () => {
		const reader = createTaskStateReader({ systemConfig: makeSystemConfig() });
		expect(await reader.read('zone-1', 'missing')).toBeNull();
	});

	it('returns null for an unknown zone', async () => {
		const reader = createTaskStateReader({ systemConfig: makeSystemConfig() });
		expect(await reader.read('missing-zone', 'task-1')).toBeNull();
	});

	it('reads the replayed TaskState for a known task', async () => {
		const taskId = 't-1';
		const filePath = path.join(stateDir, 'tasks', taskId, 'state', 'tasks', `${taskId}.jsonl`);
		await appendEvent(filePath, {
			event: 'task-accepted',
			taskId,
			config: makeMinimalTaskConfig(taskId),
		});
		await appendEvent(filePath, { event: 'task-completed' });

		const reader = createTaskStateReader({ systemConfig: makeSystemConfig() });
		const state = await reader.read('zone-1', taskId);

		expect(state?.taskId).toBe(taskId);
		expect(state?.status).toBe('completed');
	});

	it('throws for malformed task logs instead of reporting them as missing', async () => {
		const taskId = 'bad-log';
		const filePath = path.join(stateDir, 'tasks', taskId, 'state', 'tasks', `${taskId}.jsonl`);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			filePath,
			JSON.stringify({
				ts: new Date().toISOString(),
				data: { event: 'task-failed', reason: 'boot failed' },
			}),
		);

		const reader = createTaskStateReader({ systemConfig: makeSystemConfig() });

		await expect(reader.read('zone-1', taskId)).rejects.toThrow(
			'does not begin with task-accepted',
		);
	});

	it('reads a controller-written task-failed sentinel when the event log is unavailable', async () => {
		const taskId = 'sentinel-failed';
		await writeTaskFailureSentinel({
			config: makeMinimalTaskConfig(taskId),
			reason: 'event log unavailable; worker task failed: vm-boot-failed',
			stateDir: path.join(stateDir, 'tasks', taskId, 'state'),
			taskId,
		});

		const reader = createTaskStateReader({ systemConfig: makeSystemConfig() });
		const state = await reader.read('zone-1', taskId);

		expect(state?.status).toBe('failed');
		expect(state?.failureReason).toContain('vm-boot-failed');
	});

	it('uses the task-failed sentinel when the event log exists but cannot hydrate state', async () => {
		const taskId = 'sentinel-empty-log';
		const taskStateDir = path.join(stateDir, 'tasks', taskId, 'state');
		const filePath = path.join(taskStateDir, 'tasks', `${taskId}.jsonl`);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, '');
		await writeTaskFailureSentinel({
			config: makeMinimalTaskConfig(taskId),
			reason: 'event log write failed after file creation',
			stateDir: taskStateDir,
			taskId,
		});

		const reader = createTaskStateReader({ systemConfig: makeSystemConfig() });
		const state = await reader.read('zone-1', taskId);

		expect(state?.status).toBe('failed');
		expect(state?.failureReason).toContain('file creation');
	});
});
