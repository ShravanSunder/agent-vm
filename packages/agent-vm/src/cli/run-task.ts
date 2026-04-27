import type { RunTaskFn } from '../shared/run-task.js';
import type { CliIo } from './agent-vm-cli-support.js';

export function createPlainRunTask(io: CliIo): RunTaskFn {
	return async (title, fn) => {
		io.stderr.write(`  ${title}...\n`);
		await fn({
			interactive: false,
			setOutput: () => {},
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
						taskState.startTime();
						await fn({
							interactive: true,
							setOutput: (output) => {
								taskState.setOutput(output);
							},
							setStatus: (status) => {
								taskState.setStatus(status);
							},
							streamPreview: taskState.streamPreview,
						});
					},
					{ previewLines: 8 },
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
