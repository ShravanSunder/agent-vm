import { afterEach, describe, expect, it } from 'vitest';

import { createRunTask } from './run-task.js';

const originalStdoutIsTty = process.stdout.isTTY;

afterEach(() => {
	Object.defineProperty(process.stdout, 'isTTY', {
		configurable: true,
		value: originalStdoutIsTty,
	});
});

describe('createRunTask', () => {
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
