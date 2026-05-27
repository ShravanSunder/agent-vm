import type {
	RunTaskContext,
	RunTaskFn,
	RunTaskGroupFn,
	RunTaskGroupTask,
} from '../shared/run-task.js';
import type { CliIo } from './agent-vm-cli-support.js';

function createTasukuTaskContext(taskState: {
	readonly setOutput: (output: string | { readonly message: string }) => void;
	readonly setStatus: (status?: string) => void;
	readonly startTime: () => void;
	readonly streamPreview?: RunTaskContext['streamPreview'];
}): RunTaskContext {
	taskState.startTime();
	return {
		interactive: true,
		setOutput: (output) => {
			taskState.setOutput(output);
		},
		setStatus: (status) => {
			taskState.setStatus(status);
		},
		...(taskState.streamPreview ? { streamPreview: taskState.streamPreview } : {}),
	};
}

export function createPlainRunTask(io: CliIo): RunTaskFn {
	return async (title, fn) => {
		io.stderr.write(`  ${title}...\n`);
		await fn({
			interactive: false,
			setOutput: (output) => {
				const message = typeof output === 'string' ? output : output.message;
				io.stderr.write(`${message}\n`);
			},
			setStatus: () => {},
		});
		io.stderr.write(`  ${title} done\n`);
	};
}

export async function createRunTask(io: CliIo): Promise<RunTaskFn> {
	if (process.stdout.isTTY) {
		const { default: task } = await import('tasuku');

		return async (title, fn) => {
			let taskStarted = false;
			try {
				await task(
					title,
					async (taskState) => {
						taskStarted = true;
						await fn(createTasukuTaskContext(taskState));
					},
					{ previewLines: 1 },
				);
			} catch (error) {
				if (taskStarted) {
					throw error;
				}
				await createPlainRunTask(io)(title, fn);
			}
		};
	}

	return createPlainRunTask(io);
}

export function createPlainRunTaskGroup(runTask: RunTaskFn): RunTaskGroupFn {
	return async (tasks, options) => {
		let nextIndex = 0;
		const workerCount = Math.min(options.concurrency, tasks.length);
		const workers = Array.from({ length: workerCount }, async () => {
			for (;;) {
				const task = tasks[nextIndex];
				nextIndex += 1;
				if (!task) {
					return;
				}
				// oxlint-disable-next-line no-await-in-loop -- each plain worker owns one serial queue while workers run in parallel
				await runTask(task.title, task.fn);
			}
		});
		await Promise.all(workers);
	};
}

export async function createRunTaskGroup(_io: CliIo, runTask: RunTaskFn): Promise<RunTaskGroupFn> {
	if (process.stdout.isTTY) {
		const { default: task } = await import('tasuku');

		return async (tasks, options) => {
			if (tasks.length === 0) {
				return;
			}
			const taskGroup = await task.group(
				(createTask) =>
					tasks.map((taskSpec: RunTaskGroupTask) =>
						createTask(taskSpec.title, async (taskState) => {
							await taskSpec.fn(createTasukuTaskContext(taskState));
						}),
					),
				{
					concurrency: options.concurrency,
					...(options.maxVisible === undefined ? {} : { maxVisible: options.maxVisible }),
				},
			);
			void taskGroup;
		};
	}

	return createPlainRunTaskGroup(runTask);
}
