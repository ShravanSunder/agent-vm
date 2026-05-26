export interface ControllerRequestPolicy {
	readonly maxAttempts: number;
	readonly retryBaseDelayMs: number;
	readonly timeoutMs: number;
}

export interface FetchControllerWithPolicyOptions extends RequestInit {
	readonly clearTimeoutImpl?: ((timeout: ReturnType<typeof setTimeout>) => void) | undefined;
	readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly operation: string;
	readonly policy: ControllerRequestPolicy;
	readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined;
	readonly setTimeoutImpl?:
		| ((callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>)
		| undefined;
}

export class ControllerRequestTimeoutError extends Error {
	readonly attempt: number;
	readonly elapsedMs: number;
	readonly maxAttempts: number;
	readonly operation: string;
	readonly timeoutMs: number;

	constructor(options: {
		readonly attempt?: number | undefined;
		readonly elapsedMs?: number | undefined;
		readonly maxAttempts?: number | undefined;
		readonly operation: string;
		readonly timeoutMs: number;
	}) {
		super(
			`Controller request '${options.operation}' timed out after ${String(options.timeoutMs)}ms`,
		);
		this.name = 'ControllerRequestTimeoutError';
		this.attempt = options.attempt ?? 1;
		this.elapsedMs = options.elapsedMs ?? options.timeoutMs;
		this.maxAttempts = options.maxAttempts ?? this.attempt;
		this.operation = options.operation;
		this.timeoutMs = options.timeoutMs;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function isRetryableControllerRequestError(error: unknown): boolean {
	if (error instanceof ControllerRequestTimeoutError || error instanceof TypeError) {
		return true;
	}
	if (error instanceof Error) {
		return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|fetch failed/u.test(
			error.message,
		);
	}
	return false;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason instanceof Error || signal.reason instanceof DOMException
		? signal.reason
		: new DOMException('The operation was aborted.', 'AbortError');
}

function isSignalAborted(signal: AbortSignal | null | undefined): signal is AbortSignal {
	return signal?.aborted === true;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function fetchControllerWithPolicy(
	input: string | URL | Request,
	options: FetchControllerWithPolicyOptions,
): Promise<Response> {
	const {
		clearTimeoutImpl = clearTimeout,
		fetchImpl,
		operation,
		policy,
		sleepImpl = sleep,
		setTimeoutImpl = setTimeout,
		...requestInit
	} = options;
	let lastError: unknown;
	const callerSignal = options.signal;
	const startedAtMs = Date.now();
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
		const abortController = new AbortController();
		if (callerSignal?.aborted === true) {
			throw abortReason(callerSignal);
		}
		const abortFromCaller = (): void => {
			abortController.abort();
		};
		callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
		const timeout = setTimeoutImpl(() => {
			abortController.abort();
		}, policy.timeoutMs);
		try {
			return await fetchImpl(input, { ...requestInit, signal: abortController.signal });
		} catch (error) {
			if (isSignalAborted(callerSignal) && isAbortError(error)) {
				lastError = abortReason(callerSignal);
			} else if (abortController.signal.aborted && isAbortError(error)) {
				lastError = new ControllerRequestTimeoutError({
					attempt,
					elapsedMs: Date.now() - startedAtMs,
					maxAttempts: policy.maxAttempts,
					operation,
					timeoutMs: policy.timeoutMs,
				});
			} else {
				lastError = error;
			}
			if (attempt >= policy.maxAttempts || !isRetryableControllerRequestError(lastError)) {
				throw lastError;
			}
			const delayMs = policy.retryBaseDelayMs * attempt;
			if (delayMs > 0) {
				await sleepImpl(delayMs);
			}
		} finally {
			callerSignal?.removeEventListener('abort', abortFromCaller);
			clearTimeoutImpl(timeout);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function drainControllerResponseBody(response: Response): Promise<void> {
	await response.arrayBuffer();
}
