import type {
	ToolVmActiveUseOperationReport,
	ToolVmSshFailureKind,
} from '@agent-vm/gateway-interface';

export class ToolVmSshOperationStaleError extends Error {
	override readonly cause: unknown;
	readonly reason: ToolVmSshFailureKind;

	constructor(options: {
		readonly cause: unknown;
		readonly message: string;
		readonly reason: ToolVmSshFailureKind;
	}) {
		super(options.message);
		this.cause = options.cause;
		this.reason = options.reason;
	}
}

export interface ToolVmSshOperationGuardOptions<TResult> {
	readonly clearTimeoutImpl?: typeof clearTimeout | undefined;
	readonly now?: (() => number) | undefined;
	readonly operation: (signal: AbortSignal) => Promise<TResult>;
	readonly operationName: string;
	readonly report: (report: ToolVmActiveUseOperationReport) => void;
	readonly setTimeoutImpl?: typeof setTimeout | undefined;
	readonly timeoutMs: number;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runToolVmSshOperationWithGuard<TResult>(
	options: ToolVmSshOperationGuardOptions<TResult>,
): Promise<TResult> {
	const now = options.now ?? Date.now;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const abortController = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	options.report({
		observedAtMs: now(),
		phase: 'running',
	});

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeoutImpl(() => {
			abortController.abort();
			reject(
				new ToolVmSshOperationStaleError({
					cause: undefined,
					message: `${options.operationName} exceeded ${String(options.timeoutMs)}ms.`,
					reason: 'ssh-command-timed-out',
				}),
			);
		}, options.timeoutMs);
	});

	try {
		const result = await Promise.race([options.operation(abortController.signal), timeoutPromise]);
		options.report({
			observedAtMs: now(),
			phase: 'completed',
			ssh: { probeSucceeded: true },
		});
		return result;
	} catch (error) {
		const staleError =
			error instanceof ToolVmSshOperationStaleError
				? error
				: new ToolVmSshOperationStaleError({
						cause: error,
						message: formatUnknownError(error),
						reason: 'ssh-command-failed',
					});
		options.report({
			observedAtMs: now(),
			phase: 'failed',
			ssh: {
				failure: {
					kind: staleError.reason,
					message: staleError.message,
				},
			},
		});
		throw staleError;
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeoutImpl(timeoutHandle);
		}
	}
}
