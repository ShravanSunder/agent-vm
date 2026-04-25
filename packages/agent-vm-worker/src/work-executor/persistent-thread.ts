import type { StructuredInput, WorkExecutor } from './executor-interface.js';

export interface PersistentThreadResponse {
	readonly response: string;
	readonly tokenCount: number;
	readonly threadId: string;
}

export interface PersistentThread {
	readonly send: (input: string) => Promise<PersistentThreadResponse>;
	readonly threadId: () => string | null;
}

export interface CreatePersistentThreadProps {
	readonly executor: WorkExecutor;
	readonly turnTimeoutMs: number;
}

function toStructuredInput(input: string): readonly StructuredInput[] {
	return [{ type: 'text', text: input }];
}

function withTimeout<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
	label: string,
): Promise<TValue> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
		}, timeoutMs);

		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

export function createPersistentThread(props: CreatePersistentThreadProps): PersistentThread {
	let started = false;

	return {
		async send(input: string): Promise<PersistentThreadResponse> {
			const result = await withTimeout(
				started
					? props.executor.fix(toStructuredInput(input))
					: props.executor.execute(toStructuredInput(input)),
				props.turnTimeoutMs,
				'persistent-thread.send',
			);
			started = true;
			return {
				response: result.response,
				tokenCount: result.tokenCount,
				threadId: result.threadId,
			};
		},
		threadId(): string | null {
			return props.executor.getThreadId();
		},
	};
}
