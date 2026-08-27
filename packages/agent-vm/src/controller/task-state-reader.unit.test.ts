import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendEvent, workerConfigSchema, type TaskConfig } from '@agent-vm/agent-vm-worker';
import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { createTaskStateReader, writeTaskFailureSentinel } from './task-state-reader.js';

let stateDir: string;

const capturedDiagnosticRecords: LogRecord[] = [];

beforeEach(async () => {
	stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-state-reader-'));
});

afterEach(async () => {
	await fs.rm(stateDir, { recursive: true, force: true });
	await dispose().catch(() => {});
	await reset();
});

function makeSystemConfig(): SystemConfig {
	return {
		schemaVersion: 2,
		storageRootDir: '/tmp/storage-root',
		cacheDir: '/tmp/cache',
		controllerStateDir: '/controller-state-test',
		controllerRuntimeDir: '/tmp/controller-runtime',
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm-tests-a1b2c3d4',
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
					zoneRuntimeDir: path.join(path.dirname(stateDir), 'runtime'),
				},
				secrets: {},
				egressHosts: ['github.com'].map((host) => ({ host, audience: 'gateway' as const })),
			},
		],
		toolVmProfiles: {
			standard: { memory: '1G', cpus: 1, imageProfile: 'default' },
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

	it('preserves operation context across real task-state diagnostics', async () => {
		capturedDiagnosticRecords.length = 0;
		await configure({
			loggers: [
				{
					category: ['agent-vm', 'controller', 'runtime'],
					lowestLevel: 'trace',
					sinks: ['capture'],
				},
			],
			reset: true,
			sinks: {
				capture: (record): void => {
					capturedDiagnosticRecords.push(record);
				},
			},
		});
		const reader = createTaskStateReader({ systemConfig: makeSystemConfig() });
		const malformedSentinelTaskId = 'malformed-sentinel';
		const malformedSentinelPath = path.join(
			stateDir,
			'tasks',
			malformedSentinelTaskId,
			'state',
			'tasks',
			`${malformedSentinelTaskId}.failed`,
		);
		await fs.mkdir(path.dirname(malformedSentinelPath), { recursive: true });
		await fs.writeFile(malformedSentinelPath, '{');

		await expect(reader.read('zone-1', malformedSentinelTaskId)).rejects.toThrow();

		const accessFailureTaskId = 'access-failure';
		await fs.writeFile(path.join(stateDir, 'tasks', accessFailureTaskId), 'not a directory');
		await expect(reader.read('zone-1', accessFailureTaskId)).rejects.toThrow();

		const malformedLogTaskId = 'malformed-log';
		const malformedLogPath = path.join(
			stateDir,
			'tasks',
			malformedLogTaskId,
			'state',
			'tasks',
			`${malformedLogTaskId}.jsonl`,
		);
		await fs.mkdir(path.dirname(malformedLogPath), { recursive: true });
		await fs.writeFile(
			malformedLogPath,
			JSON.stringify({ ts: new Date().toISOString(), data: { event: 'task-failed' } }),
		);

		await expect(reader.read('zone-1', malformedLogTaskId)).rejects.toThrow();

		expect(capturedDiagnosticRecords.map((record) => record.properties)).toEqual([
			{
				event: 'task-state-diagnostic',
				failureClass: 'failure',
				operation: 'read-task-failure-sentinel',
			},
			{
				event: 'task-state-diagnostic',
				failureClass: 'failure',
				operation: 'access-task-state-log',
			},
			{
				event: 'task-state-diagnostic',
				failureClass: 'failure',
				operation: 'invalid-task-state-log',
			},
		]);
	});
});
