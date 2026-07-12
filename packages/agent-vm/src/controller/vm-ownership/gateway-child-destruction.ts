export const MAX_GATEWAY_CHILD_DESTRUCTION_CONCURRENCY = 4;

export class GatewayChildDestructionAbortedError extends Error {
	readonly code = 'GATEWAY_CHILD_DESTRUCTION_ABORTED';

	constructor() {
		super('Gateway child destruction stopped because the subtree budget expired.');
		this.name = 'GatewayChildDestructionAbortedError';
	}
}

export async function settleGatewayChildDestructionTasks(
	tasks: readonly (() => Promise<void>)[],
	options: { readonly signal?: AbortSignal } = {},
): Promise<readonly PromiseSettledResult<void>[]> {
	const results: PromiseSettledResult<void>[] = [];
	let nextTaskIndex = 0;

	const runWorker = async (): Promise<void> => {
		while (nextTaskIndex < tasks.length) {
			if (options.signal?.aborted === true) {
				return;
			}
			const taskIndex = nextTaskIndex;
			nextTaskIndex += 1;
			const task = tasks[taskIndex];
			if (task === undefined) {
				return;
			}
			try {
				// oxlint-disable-next-line no-await-in-loop -- each worker intentionally owns one task at a time so the shared concurrency ceiling remains exact.
				await task();
				results[taskIndex] = { status: 'fulfilled', value: undefined };
			} catch (error) {
				results[taskIndex] = { reason: error, status: 'rejected' };
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(MAX_GATEWAY_CHILD_DESTRUCTION_CONCURRENCY, tasks.length) },
			async () => await runWorker(),
		),
	);
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
		results[taskIndex] ??= {
			reason: new GatewayChildDestructionAbortedError(),
			status: 'rejected',
		};
	}
	return results;
}
