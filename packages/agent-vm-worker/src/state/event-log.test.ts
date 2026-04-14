import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { workerConfigSchema } from '../config/worker-config.js';
import { appendEvent, replayEvents } from './event-log.js';

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
				effectiveConfig: workerConfigSchema.parse({}),
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

	it('skips an incomplete final line and logs to stderr', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'worker-event-log-'));
		const filePath = join(tempDir, 'tasks', 'task-1.jsonl');
		await appendEvent(filePath, { event: 'task-completed' });
		await writeFile(filePath, `${await readFile(filePath, 'utf8')}{"event":"task-accepted"`, 'utf8');
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		const events = await replayEvents(filePath);

		expect(events).toHaveLength(1);
		expect(events[0]?.data.event).toBe('task-completed');
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping incomplete final line'));
	});
});
