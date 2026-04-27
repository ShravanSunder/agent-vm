import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainRunTask, createRunTask } from './run-task.js';

const tasukuTaskMock = vi.hoisted(() => vi.fn());
const originalStdoutIsTty = process.stdout.isTTY;

vi.mock('tasuku', () => ({
	default: tasukuTaskMock,
}));

afterEach(() => {
	Object.defineProperty(process.stdout, 'isTTY', {
		configurable: true,
		value: originalStdoutIsTty,
	});
	tasukuTaskMock.mockReset();
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

	it('passes Tasuku task controls and bounded stream preview to interactive tasks', async () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value: true,
		});
		const streamPreview = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const setOutput = vi.fn();
		const setStatus = vi.fn();
		const startTime = vi.fn();
		tasukuTaskMock.mockImplementation(async (_title, fn) => {
			await fn({
				setOutput,
				setStatus,
				startTime,
				streamPreview,
			});
		});
		const observedContext: unknown[] = [];
		const runTask = await createRunTask({
			stderr: { write: () => true },
			stdout: { write: () => true },
		});

		await runTask('Docker: gateway/openclaw', async (context) => {
			observedContext.push(context);
			context?.setStatus('docker build');
			context?.setOutput('last build lines');
			context?.streamPreview?.write('docker output\n');
		});

		expect(tasukuTaskMock).toHaveBeenCalledWith('Docker: gateway/openclaw', expect.any(Function), {
			previewLines: 8,
		});
		expect(startTime).toHaveBeenCalledOnce();
		expect(setStatus).toHaveBeenCalledWith('docker build');
		expect(setOutput).toHaveBeenCalledWith('last build lines');
		expect(observedContext).toEqual([
			expect.objectContaining({
				interactive: true,
				streamPreview,
			}),
		]);
	});
});
