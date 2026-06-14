import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendEvent, workerConfigSchema, type TaskConfig } from '@agent-vm/agent-vm-worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTaskEventStream, readTaskEventLogRecords } from './task-event-stream.js';
import { writeTaskFailureSentinel } from './task-state-reader.js';

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-stream-'));
});

afterEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

function makeMinimalTaskConfig(taskId: string): TaskConfig {
	return {
		taskId,
		prompt: 'stream task',
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

function eventLogPath(taskId: string): string {
	return path.join(tempRoot, 'tasks', taskId, 'state', 'tasks', `${taskId}.jsonl`);
}

describe('task event stream', () => {
	it('replays task events after the provided line cursor', async () => {
		const taskId = 'task-replay';
		const filePath = eventLogPath(taskId);
		await appendEvent(filePath, {
			event: 'task-accepted',
			taskId,
			config: makeMinimalTaskConfig(taskId),
		});
		await appendEvent(filePath, { event: 'phase-started', phase: 'plan' });
		await appendEvent(filePath, { event: 'task-completed' });

		const result = await readTaskEventLogRecords({ afterLineIndex: 0, eventLogPath: filePath });

		expect(result.records.map((record) => [record.id, record.event.data.event])).toEqual([
			[1, 'phase-started'],
			[2, 'task-completed'],
		]);
	});

	it('waits for an incomplete final line to become a valid event', async () => {
		const taskId = 'task-corrupt-final-line';
		const filePath = eventLogPath(taskId);
		await appendEvent(filePath, {
			event: 'task-accepted',
			taskId,
			config: makeMinimalTaskConfig(taskId),
		});
		const stablePrefix = await readFile(filePath, 'utf8');
		await writeFile(filePath, `${stablePrefix}{ "ts":`);

		let sleepCount = 0;
		const stream = createTaskEventStream({
			afterLineIndex: 0,
			eventLogPath: filePath,
			sleep: async () => {
				sleepCount += 1;
				await writeFile(
					filePath,
					`${stablePrefix}${JSON.stringify({
						ts: '2026-06-12T00:00:00.000Z',
						data: { event: 'task-completed' },
					})}\n`,
				);
			},
		});

		const next = await stream[Symbol.asyncIterator]().next();

		expect(sleepCount).toBe(1);
		expect(next.value).toMatchObject({
			id: 1,
			event: { data: { event: 'task-completed' } },
		});
	});

	it('tails appended events and closes after a terminal event', async () => {
		const taskId = 'task-tail';
		const filePath = eventLogPath(taskId);
		await appendEvent(filePath, {
			event: 'task-accepted',
			taskId,
			config: makeMinimalTaskConfig(taskId),
		});
		let sleepCount = 0;
		const stream = createTaskEventStream({
			afterLineIndex: 0,
			eventLogPath: filePath,
			sleep: async () => {
				sleepCount += 1;
				await appendEvent(filePath, { event: 'task-completed' });
			},
		});
		const iterator = stream[Symbol.asyncIterator]();

		const terminal = await iterator.next();
		const done = await iterator.next();

		expect(sleepCount).toBe(1);
		expect(terminal.value).toMatchObject({
			id: 1,
			event: { data: { event: 'task-completed' } },
		});
		expect(done.done).toBe(true);
	});

	it('emits a task-failed event from the sentinel when the event log is missing', async () => {
		const taskId = 'task-sentinel';
		const stateDir = path.join(tempRoot, 'tasks', taskId, 'state');
		await writeTaskFailureSentinel({
			config: makeMinimalTaskConfig(taskId),
			reason: 'vm boot failed before worker log existed',
			stateDir,
			taskId,
		});
		const stream = createTaskEventStream({
			eventLogPath: path.join(stateDir, 'tasks', `${taskId}.jsonl`),
			failureSentinelPath: path.join(stateDir, 'tasks', `${taskId}.failed`),
			sleep: async () => {
				throw new Error('sentinel should end the stream without polling');
			},
		});

		const next = await stream[Symbol.asyncIterator]().next();

		expect(next.value).toMatchObject({
			id: 0,
			event: {
				data: {
					event: 'task-failed',
					reason: 'vm boot failed before worker log existed',
				},
			},
		});
	});
});
