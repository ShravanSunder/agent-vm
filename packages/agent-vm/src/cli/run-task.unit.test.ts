import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainRunTask, createRunTask } from './run-task.js';

const tasukuTaskMock = vi.hoisted(() => vi.fn());
const originalStdoutIsTty = process.stdout.isTTY;

type TasukuGroupMock = (
	createTasks: (
		createTask: (
			title: string,
			fn: (taskState: {
				readonly setOutput: (output: string | { readonly message: string }) => void;
				readonly setStatus: (status?: string) => void;
				readonly startTime: () => void;
			}) => Promise<void>,
		) => unknown,
	) => readonly unknown[],
	options: { readonly concurrency?: number; readonly maxVisible?: number },
) => Promise<{ readonly clear: () => void }>;

function tasukuTaskWithGroup(): typeof tasukuTaskMock & {
	group: ReturnType<typeof vi.fn<TasukuGroupMock>>;
} {
	return tasukuTaskMock as typeof tasukuTaskMock & {
		group: ReturnType<typeof vi.fn<TasukuGroupMock>>;
	};
}

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

		await runTask('Docker: gateway/hermes', async (context) => {
			observedContext.push(context);
			context?.setStatus('docker build');
			context?.setOutput('last build lines');
			context?.streamPreview?.write('docker output\n');
		});

		expect(tasukuTaskMock).toHaveBeenCalledWith('Docker: gateway/hermes', expect.any(Function), {
			previewLines: 1,
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

	it('uses Tasuku task groups for interactive parallel task phases', async () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value: true,
		});
		const setStatus = vi.fn();
		const startTime = vi.fn();
		const registeredTasks: { readonly run: () => Promise<void>; readonly title: string }[] = [];
		tasukuTaskWithGroup().group = vi.fn<TasukuGroupMock>(async (createTasks, options) => {
			const tasks = createTasks((title, fn) => {
				registeredTasks.push({
					title,
					run: async () => {
						await fn({ setOutput: vi.fn(), setStatus, startTime });
					},
				});
				return {
					clear: vi.fn(),
					task: { children: [], state: 'pending', title },
					[Symbol('run')]: vi.fn(),
				};
			});
			for (const registeredTask of registeredTasks) {
				// oxlint-disable-next-line no-await-in-loop -- this mock executes registered Tasuku tasks deterministically
				await registeredTask.run();
			}
			expect(tasks).toHaveLength(2);
			expect(options).toEqual({ concurrency: 2 });
			return { clear: vi.fn() };
		});
		const runTask = await createRunTask({
			stderr: { write: () => true },
			stdout: { write: () => true },
		});
		const { createRunTaskGroup } = await import('./run-task.js');
		const runTaskGroup = await createRunTaskGroup(
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			runTask,
		);

		await runTaskGroup(
			[
				{ title: 'Docker: gateway/hermes', fn: async (context) => context?.setStatus('one') },
				{ title: 'Docker: toolVm/default', fn: async (context) => context?.setStatus('two') },
			],
			{ concurrency: 2 },
		);

		expect(tasukuTaskWithGroup().group).toHaveBeenCalledOnce();
		expect(registeredTasks.map((task) => task.title)).toEqual([
			'Docker: gateway/hermes',
			'Docker: toolVm/default',
		]);
		expect(startTime).toHaveBeenCalledTimes(2);
		expect(setStatus).toHaveBeenCalledWith('one');
		expect(setStatus).toHaveBeenCalledWith('two');
	});
});
