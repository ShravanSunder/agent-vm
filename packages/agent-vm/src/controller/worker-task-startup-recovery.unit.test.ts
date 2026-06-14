import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	appendEvent,
	workerConfigSchema,
	type TaskConfig,
	type TaskEvent,
} from '@agent-vm/agent-vm-worker';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayZone } from '../gateway/gateway-zone-support.js';
import {
	classifyTaskLogForRecovery,
	classifyTaskEventLogForRecovery,
	recoverOrphanedWorkerTasksAtStartup,
	workerTaskRestartFailureReason,
	type TaskLogRecoveryClassification,
} from './worker-task-startup-recovery.js';

function makeEvent(event: string): {
	readonly data: { readonly event: string };
	readonly ts: string;
} {
	return {
		data: { event },
		ts: '2026-06-11T00:00:00.000Z',
	};
}

function makeWorkerZone(overrides?: { readonly stateDir?: string }): GatewayZone {
	return {
		id: overrides?.stateDir?.includes('zone-2') === true ? 'zone-2' : 'zone-1',
		gateway: {
			type: 'worker',
			imageProfile: 'worker',
			memory: '2G',
			cpus: 2,
			port: 18791,
			config: '/tmp/worker-config.json',
			stateDir: overrides?.stateDir ?? '/tmp/state',
		},
		secrets: {},
		egressHosts: [],
		websocketBypass: [],
	};
}

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

async function writeTimestampedEventLine(eventLogPath: string, event: TaskEvent): Promise<void> {
	await appendEvent(eventLogPath, event);
}

describe('classifyTaskLogForRecovery', () => {
	it.each([['task-completed'], ['task-failed'], ['task-closed']])(
		'classifies %s as terminal',
		(terminalEvent) => {
			const classification = classifyTaskLogForRecovery([
				makeEvent('task-accepted'),
				makeEvent(terminalEvent),
			]);

			expect(classification).toBe('terminal');
		},
	);

	it('classifies accepted logs without terminal events as needing a failure event', () => {
		const classification = classifyTaskLogForRecovery([
			makeEvent('task-accepted'),
			makeEvent('phase-started'),
			makeEvent('work-agent-turn'),
		]);

		expect(classification).toBe('needs-failure-event');
	});

	it.each([
		['empty log', []],
		['missing accepted event', [makeEvent('phase-started')]],
	])('classifies %s as unreadable', (_name, events) => {
		expect(classifyTaskLogForRecovery(events)).toBe('unreadable');
	});
});

describe('classifyTaskEventLogForRecovery', () => {
	it('treats terminal task state followed by controller events as terminal', async () => {
		const taskId = '11111111-1111-4111-8111-111111111111';
		const temporaryDirectory = await fs.mkdtemp('/tmp/worker-task-startup-recovery-');
		const eventLogPath = `${temporaryDirectory}/${taskId}.jsonl`;
		await appendEvent(eventLogPath, {
			event: 'task-accepted',
			taskId,
			config: makeMinimalTaskConfig(taskId),
		});
		await appendEvent(eventLogPath, { event: 'task-completed' });
		await writeTimestampedEventLine(eventLogPath, {
			event: 'controller-git-pull-succeeded',
			repoUrl: 'https://github.com/acme/widgets.git',
			attempts: 1,
			defaultBranch: 'main',
		});

		const classification = await classifyTaskEventLogForRecovery(eventLogPath);

		expect(classification).toBe('terminal');
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	});
});

describe('recoverOrphanedWorkerTasksAtStartup', () => {
	it('appends a restart failure event and cleans task resources for replayable non-terminal logs', async () => {
		const appendedEvents: Array<{ readonly eventLogPath: string; readonly reason: string }> = [];
		const cleanedTasks: string[] = [];

		const result = await recoverOrphanedWorkerTasksAtStartup(
			{
				systemConfig: {
					runtimeDir: '/tmp/runtime',
					zones: [makeWorkerZone({ stateDir: '/tmp/state' })],
				},
			},
			{
				appendEvent: async (eventLogPath, event) => {
					appendedEvents.push({ eventLogPath, reason: event.reason });
				},
				classifyTaskEventLogForRecovery: async () => 'needs-failure-event',
				cleanupTaskRuntime: async ({ taskId }) => {
					cleanedTasks.push(taskId);
				},
				listTaskIds: async () => ['task-1'],
			},
		);

		expect(result.recoveredCount).toBe(1);
		expect(appendedEvents).toEqual([
			{
				eventLogPath: '/tmp/state/tasks/task-1/state/tasks/task-1.jsonl',
				reason: workerTaskRestartFailureReason,
			},
		]);
		expect(cleanedTasks).toEqual(['task-1']);
		expect(result.warnings).toContainEqual(expect.stringContaining('worker VM'));
	});

	it('recovers only selected worker zones when startup is scoped to selected zones', async () => {
		const listedZones: string[] = [];
		const cleanedZones: string[] = [];

		const result = await recoverOrphanedWorkerTasksAtStartup(
			{
				systemConfig: {
					runtimeDir: '/tmp/runtime',
					zones: [
						makeWorkerZone({ stateDir: '/tmp/state/zone-1' }),
						makeWorkerZone({ stateDir: '/tmp/state/zone-2' }),
					],
				},
				zoneIds: ['zone-2'],
			},
			{
				appendEvent: async () => {},
				classifyTaskEventLogForRecovery: async () => 'needs-failure-event',
				cleanupTaskRuntime: async ({ taskId, zone }) => {
					cleanedZones.push(`${zone.id}:${taskId}`);
				},
				listTaskIds: async (zone) => {
					listedZones.push(zone.id);
					return [`task-${zone.id}`];
				},
			},
		);

		expect(result.recoveredCount).toBe(1);
		expect(listedZones).toEqual(['zone-2']);
		expect(cleanedZones).toEqual(['zone-2:task-zone-2']);
	});

	it('continues after per-task recovery failures and reports warnings', async () => {
		const result = await recoverOrphanedWorkerTasksAtStartup(
			{
				systemConfig: {
					runtimeDir: '/tmp/runtime',
					zones: [makeWorkerZone({ stateDir: '/tmp/state' })],
				},
			},
			{
				appendEvent: vi
					.fn()
					.mockRejectedValueOnce(new Error('append failed'))
					.mockResolvedValueOnce(undefined),
				classifyTaskEventLogForRecovery: async (): Promise<TaskLogRecoveryClassification> =>
					'needs-failure-event',
				cleanupTaskRuntime: async () => {},
				listTaskIds: async () => ['task-a', 'task-b'],
			},
		);

		expect(result.recoveredCount).toBe(1);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Failed to recover worker task 'task-a'"),
				expect.stringContaining('append failed'),
			]),
		);
	});

	it('writes a failure sentinel when the log is unreadable but the accepted config can be recovered', async () => {
		const sentinelWrites: Array<{ readonly reason: string; readonly stateDir: string }> = [];

		const result = await recoverOrphanedWorkerTasksAtStartup(
			{
				systemConfig: {
					runtimeDir: '/tmp/runtime',
					zones: [makeWorkerZone({ stateDir: '/tmp/state' })],
				},
			},
			{
				classifyTaskEventLogForRecovery: async () => 'unreadable',
				cleanupTaskRuntime: async () => {},
				listTaskIds: async () => ['task-corrupt'],
				readTaskAcceptedConfig: async () => makeMinimalTaskConfig('task-corrupt'),
				writeFailureSentinel: async ({ reason, stateDir }) => {
					sentinelWrites.push({ reason, stateDir });
				},
			},
		);

		expect(result.recoveredCount).toBe(1);
		expect(sentinelWrites).toEqual([
			{
				reason: workerTaskRestartFailureReason,
				stateDir: '/tmp/state/tasks/task-corrupt/state',
			},
		]);
	});

	it('still prunes rebuildable resources when a task cannot be marked terminal', async () => {
		const cleanedTasks: string[] = [];

		const result = await recoverOrphanedWorkerTasksAtStartup(
			{
				systemConfig: {
					runtimeDir: '/tmp/runtime',
					zones: [makeWorkerZone({ stateDir: '/tmp/state' })],
				},
			},
			{
				classifyTaskEventLogForRecovery: async () => 'unreadable',
				cleanupTaskRuntime: async ({ taskId }) => {
					cleanedTasks.push(taskId);
				},
				listTaskIds: async () => ['task-without-config'],
				readTaskAcceptedConfig: async () => null,
			},
		);

		expect(result.recoveredCount).toBe(0);
		expect(cleanedTasks).toEqual(['task-without-config']);
		expect(result.warnings).toContainEqual(
			expect.stringContaining('no task-accepted config could be recovered'),
		);
	});

	it('reconstructs repo resource provider handles from task runtime metadata before cleanup', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'worker-task-startup-recovery-'),
		);
		try {
			const taskId = '66666666-6666-4666-8666-666666666666';
			const stateDir = path.join(temporaryDirectory, 'state');
			const runtimeDir = path.join(temporaryDirectory, 'runtime');
			const zone = makeWorkerZone({ stateDir });
			const eventLogPath = path.join(
				stateDir,
				'tasks',
				taskId,
				'state',
				'tasks',
				`${taskId}.jsonl`,
			);
			await appendEvent(eventLogPath, {
				event: 'task-accepted',
				taskId,
				config: makeMinimalTaskConfig(taskId),
			});
			await appendEvent(eventLogPath, { event: 'phase-started', phase: 'work' });
			await fs.mkdir(path.join(stateDir, 'tasks', taskId, 'agent-vm', 'resources', 'repo-a'), {
				recursive: true,
			});
			const repoMetadataDirectory = path.join(
				runtimeDir,
				'worker-tasks',
				zone.id,
				taskId,
				'repo-metadata',
				'repo-a',
			);
			await fs.mkdir(path.join(repoMetadataDirectory, '.agent-vm'), { recursive: true });
			await fs.writeFile(
				path.join(repoMetadataDirectory, '.agent-vm', 'docker-compose.yml'),
				'services: {}\n',
			);

			let observedProviders:
				| readonly {
						readonly composeFilePath: string;
						readonly composeProjectName: string;
						readonly repoDir: string;
						readonly repoId: string;
				  }[]
				| null = null;
			const result = await recoverOrphanedWorkerTasksAtStartup(
				{
					systemConfig: {
						runtimeDir,
						zones: [zone],
					},
				},
				{
					postStopGateway: async (_taskId, _zone, providers) => {
						observedProviders = providers ?? [];
					},
				},
			);

			expect(result.recoveredCount).toBe(1);
			expect(observedProviders).toEqual([
				{
					composeFilePath: path.join(repoMetadataDirectory, '.agent-vm', 'docker-compose.yml'),
					composeProjectName: `agent-vm-${taskId}-repo-a`,
					repoDir: repoMetadataDirectory,
					repoId: 'repo-a',
				},
			]);
		} finally {
			await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
