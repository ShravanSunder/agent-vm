import { runWorkerHealthOperation, runWorkerServeLifecycle } from './worker-cli-operations.js';
import type { WorkerCommand } from './worker-cli-parser.js';

interface WorkerCommandOperations {
	readonly runHealth: (
		command: Extract<WorkerCommand, { readonly command: 'health' }>,
	) => Promise<void>;
	readonly runServe: (
		command: Extract<WorkerCommand, { readonly command: 'serve' }>,
	) => Promise<void>;
}

const defaultWorkerCommandOperations = {
	runHealth: runWorkerHealthOperation,
	runServe: runWorkerServeLifecycle,
} satisfies WorkerCommandOperations;

function assertNever(value: never): never {
	throw new Error(`Unexpected Worker command: ${JSON.stringify(value)}`);
}

export async function dispatchWorkerCommand(
	command: WorkerCommand,
	operations: WorkerCommandOperations = defaultWorkerCommandOperations,
): Promise<void> {
	switch (command.command) {
		case 'health':
			await operations.runHealth(command);
			return;
		case 'serve':
			await operations.runServe(command);
			return;
		default:
			return assertNever(command);
	}
}
