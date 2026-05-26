export interface ControllerRequestPolicy {
	readonly maxAttempts: number;
	readonly retryBaseDelayMs: number;
	readonly timeoutMs: number;
}

export const controllerRequestCauseCodes = [
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'ENETUNREACH',
	'ENOTFOUND',
	'EPIPE',
	'FETCH_FAILED',
] as const;

export type ControllerRequestCauseCode = (typeof controllerRequestCauseCodes)[number];

const controllerRequestCauseCodeSet: ReadonlySet<string> = new Set(controllerRequestCauseCodes);

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

export class ControllerRequestFailureError extends Error {
	readonly attempt: number;
	override readonly cause: unknown;
	readonly causeCode: ControllerRequestCauseCode | undefined;
	readonly maxAttempts: number;
	readonly operation: string;

	constructor(options: {
		readonly attempt: number;
		readonly cause: unknown;
		readonly maxAttempts: number;
		readonly operation: string;
	}) {
		const causeCode = extractControllerRequestCauseCode(options.cause);
		super(
			`Controller request '${options.operation}' failed${
				causeCode === undefined ? '' : ` with ${causeCode}`
			}`,
		);
		this.name = 'ControllerRequestFailureError';
		this.attempt = options.attempt;
		this.cause = options.cause;
		this.causeCode = causeCode;
		this.maxAttempts = options.maxAttempts;
		this.operation = options.operation;
	}
}

function isControllerRequestCauseCode(value: string): value is ControllerRequestCauseCode {
	return controllerRequestCauseCodeSet.has(value);
}

function extractControllerRequestCauseCode(
	error: unknown,
	depth = 0,
): ControllerRequestCauseCode | undefined {
	if (depth > 4) {
		return undefined;
	}
	if (typeof error === 'object' && error !== null && 'code' in error) {
		const code = error.code;
		if (typeof code === 'string' && isControllerRequestCauseCode(code)) {
			return code;
		}
	}
	if (typeof error === 'object' && error !== null && 'cause' in error) {
		const nestedCauseCode = extractControllerRequestCauseCode(error.cause, depth + 1);
		if (nestedCauseCode !== undefined) {
			return nestedCauseCode;
		}
	}
	if (error instanceof Error) {
		const match = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|EPIPE/u.exec(
			error.message,
		);
		if (match && isControllerRequestCauseCode(match[0])) {
			return match[0];
		}
		if (/fetch failed/u.test(error.message)) {
			return 'FETCH_FAILED';
		}
	}
	return undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function isRetryableControllerRequestError(error: unknown): boolean {
	if (error instanceof ControllerRequestTimeoutError || error instanceof TypeError) {
		return true;
	}
	if (error instanceof Error) {
		return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|EPIPE|fetch failed/u.test(
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
			// oxlint-disable-next-line eslint/no-await-in-loop -- retries must be sequential.
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
			if (isSignalAborted(callerSignal)) {
				throw abortReason(callerSignal);
			}
			const retryable = isRetryableControllerRequestError(lastError);
			if (attempt >= policy.maxAttempts || !retryable) {
				if (
					retryable &&
					!(lastError instanceof ControllerRequestTimeoutError) &&
					!isSignalAborted(callerSignal)
				) {
					throw new ControllerRequestFailureError({
						attempt,
						cause: lastError,
						maxAttempts: policy.maxAttempts,
						operation,
					});
				}
				throw lastError;
			}
			const delayMs = policy.retryBaseDelayMs * attempt;
			if (delayMs > 0) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- retry backoff is intentionally ordered.
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
	if (response.bodyUsed) {
		return;
	}
	await response.arrayBuffer();
}
