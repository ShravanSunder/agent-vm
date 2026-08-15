import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { getConfig, reset } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workerConfigSchema } from '../config/worker-config.js';
import { configureProcessLogging } from '../shared/process-logging.js';
import { appendEvent, replayEvents } from './event-log.js';

function buildWorkerConfigInput(): Record<string, unknown> {
	return {
		runtimeInstructions: 'runtime facts',
		commonAgentInstructions: null,
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
	};
}

describe('event-log', () => {
	let tempDir: string | null = null;

	afterEach(async () => {
		if (tempDir !== null) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
		vi.restoreAllMocks();
	});

	it('round-trips JSONL events', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'worker-event-log-'));
		const filePath = join(tempDir, 'tasks', 'task-1.jsonl');

		await appendEvent(filePath, {
			event: 'task-accepted',
			taskId: 'task-1',
			config: {
				taskId: 'task-1',
				prompt: 'fix bug',
				repos: [],
				context: {},
				effectiveConfig: workerConfigSchema.parse(buildWorkerConfigInput()),
			},
		});
		await appendEvent(filePath, { event: 'task-completed' });

		const events = await replayEvents(filePath);
		expect(events.map((event) => event.data.event)).toEqual(['task-accepted', 'task-completed']);
	});

	it('throws on corrupt non-final lines', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'worker-event-log-'));
		const filePath = join(tempDir, 'tasks', 'task-1.jsonl');
		await mkdir(join(tempDir, 'tasks'), { recursive: true });
		await writeFile(filePath, '{"bad":true}\n{"event":"task-completed"}\n', 'utf8');

		await expect(replayEvents(filePath)).rejects.toThrow('Corrupt event at line 1');
	});

	it('skips an incomplete final line and emits a bounded state diagnostic', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'worker-event-log-'));
		const filePath = join(tempDir, 'tasks', 'task-1.jsonl');
		await appendEvent(filePath, { event: 'task-completed' });
		await writeFile(
			filePath,
			`${await readFile(filePath, 'utf8')}{"event":"task-accepted"`,
			'utf8',
		);
		const chunks: string[] = [];
		const stderr = new Writable({
			write: (chunk: Uint8Array, _encoding, callback): void => {
				chunks.push(Buffer.from(chunk).toString('utf8'));
				callback();
			},
		});
		const logging = await configureProcessLogging({ stderr });

		try {
			const events = await replayEvents(filePath);

			expect(events).toHaveLength(1);
			expect(events[0]?.data.event).toBe('task-completed');
			await logging.shutdown();
			expect(chunks.join('')).toContain('event-log-tail-incomplete');
			expect(chunks.join('')).not.toContain(filePath);
		} finally {
			await logging.shutdown();
			if (getConfig() !== null) await reset();
		}
	});
});
