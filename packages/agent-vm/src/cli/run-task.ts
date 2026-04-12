import type { RunTaskFn } from '../shared/run-task.js';
import type { CliIo } from './agent-vm-cli-support.js';

export async function createRunTask(io: CliIo): Promise<RunTaskFn> {
	if (process.stdout.isTTY) {
		const { default: task } = await import('tasuku');

		return async (title, fn) => {
			await task(title, async (taskState) => {
				taskState.startTime();
				await fn();
			});
		};
	}

	return async (title, fn) => {
		io.stderr.write(`  ${title}...\n`);
		await fn();
		io.stderr.write(`  ${title} done\n`);
	};
}
