import { afterEach, describe, expect, it } from 'vitest';

import { createPlainRunTask, createRunTask } from './run-task.js';

const originalStdoutIsTty = process.stdout.isTTY;

afterEach(() => {
	Object.defineProperty(process.stdout, 'isTTY', {
		configurable: true,
		value: originalStdoutIsTty,
	});
});

describe('createRunTask', () => {
	it('creates a plain progress task runner without terminal UI dependencies', async () => {
		const stderrChunks: string[] = [];
		const runTask = createPlainRunTask({
			stderr: {
				write: (chunk: string | Uint8Array) => {
					stderrChunks.push(String(chunk));
					return true;
				},
			},
			stdout: { write: () => true },
		});

		await runTask('Building Gondolin VM assets', async () => {});

		expect(stderrChunks.join('')).toContain('Building Gondolin VM assets...');
		expect(stderrChunks.join('')).toContain('Building Gondolin VM assets done');
	});

	it('writes plain progress messages to stderr when stdout is not a TTY', async () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value: false,
		});
		const stderrChunks: string[] = [];
		const runTask = await createRunTask({
			stderr: {
				write: (chunk: string | Uint8Array) => {
					stderrChunks.push(String(chunk));
					return true;
				},
			},
			stdout: { write: () => true },
		});

		await runTask('Booting gateway VM', async () => {});

		expect(stderrChunks.join('')).toContain('Booting gateway VM...');
		expect(stderrChunks.join('')).toContain('Booting gateway VM done');
	});
});
