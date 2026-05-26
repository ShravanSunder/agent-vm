export const gatewayInternalControllerRequestOperations = [
	'controller-health',
	'health-event-publish',
	'openclaw-runtime-status',
	'zone-git-push',
	'lease-create',
	'lease-get',
	'lease-peek',
	'lease-list',
	'lease-renew',
	'lease-release',
	'lease-use-start',
	'lease-heartbeat',
	'lease-use-end',
] as const;

export type GatewayInternalControllerRequestOperation =
	(typeof gatewayInternalControllerRequestOperations)[number];

export const workerInternalControllerRequestOperations = [
	'worker-push-branches',
	'worker-pull-default',
] as const;

export type WorkerInternalControllerRequestOperation =
	(typeof workerInternalControllerRequestOperations)[number];

export type ControllerRequestPolicyOperation =
	| GatewayInternalControllerRequestOperation
	| WorkerInternalControllerRequestOperation;

export const dedicatedControllerRequestHealthEventOperations = [
	'lease-heartbeat',
	'lease-renew',
] as const;

export type DedicatedControllerRequestHealthEventOperation =
	(typeof dedicatedControllerRequestHealthEventOperations)[number];

export type GenericControllerRequestEventOperation = Exclude<
	ControllerRequestPolicyOperation,
	DedicatedControllerRequestHealthEventOperation
>;

const dedicatedControllerRequestHealthEventOperationSet = new Set<ControllerRequestPolicyOperation>(
	dedicatedControllerRequestHealthEventOperations,
);

function isGenericControllerRequestEventOperation(
	operation: ControllerRequestPolicyOperation,
): operation is GenericControllerRequestEventOperation {
	return !dedicatedControllerRequestHealthEventOperationSet.has(operation);
}

export const genericControllerRequestEventOperations = [
	...gatewayInternalControllerRequestOperations,
	...workerInternalControllerRequestOperations,
].filter(isGenericControllerRequestEventOperation);

export const externalControllerRoutes = [
	'GET /controller-status',
	'GET /zones/:zoneId/status',
	'GET /zones/:zoneId/health',
	'GET /zones/:zoneId/zone-git/status',
	'GET /zones/:zoneId/logs',
	'POST /zones/:zoneId/credentials/refresh',
	'POST /zones/:zoneId/destroy',
	'POST /zones/:zoneId/upgrade',
	'GET /zones/:zoneId/tasks/:taskId',
	'POST /zones/:zoneId/worker-tasks',
	'POST /zones/:zoneId/tasks/:taskId/close',
	'POST /zones/:zoneId/enable-ssh',
	'POST /zones/:zoneId/execute-command',
	'POST /stop-controller',
] as const;

export type ExternalControllerRoute = (typeof externalControllerRoutes)[number];

export type ControllerRequestPolicyIdempotency = 'read' | 'safe-mutation' | 'unsafe-mutation';

interface ControllerRequestPolicyBase {
	readonly idempotency: ControllerRequestPolicyIdempotency;
	readonly timeoutMs: number;
}

export type ControllerRequestPolicy =
	| (ControllerRequestPolicyBase & {
			readonly maxAttempts: 1;
			readonly retryBaseDelayMs: 0;
			readonly retryEnabled: false;
			readonly retryStatuses: readonly [];
	  })
	| (ControllerRequestPolicyBase & {
			readonly maxAttempts: number;
			readonly retryBaseDelayMs: number;
			readonly retryEnabled: true;
			readonly retryStatuses: readonly [number, ...number[]];
	  });

export type ControllerRequestPolicyTransportErrorCode =
	| 'controller-request-failed'
	| 'controller-request-timeout';

export class ControllerRequestPolicyTransportError extends Error {
	readonly code: ControllerRequestPolicyTransportErrorCode;
	readonly operation: ControllerRequestPolicyOperation;

	constructor(options: {
		readonly cause: unknown;
		readonly code: ControllerRequestPolicyTransportErrorCode;
		readonly operation: ControllerRequestPolicyOperation;
	}) {
		const causeMessage =
			options.cause instanceof Error ? options.cause.message : String(options.cause);
		super(`${options.operation} ${options.code}: ${causeMessage}`, {
			cause: options.cause,
		});
		this.code = options.code;
		this.operation = options.operation;
	}
}

export interface FetchControllerWithPolicyOptions {
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly init?: RequestInit;
	readonly input: string | URL | Request;
	readonly operation: ControllerRequestPolicyOperation;
	readonly policy?: ControllerRequestPolicy;
}

function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason);
			return;
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(signal?.reason);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function shouldRetryResponse(response: Response, policy: ControllerRequestPolicy): boolean {
	return policy.retryEnabled && policy.retryStatuses.includes(response.status);
}

export async function drainControllerResponseBody(response: Response): Promise<void> {
	if (response.bodyUsed) {
		return;
	}
	await response.text().catch(() => undefined);
}

async function fetchWithTimeout(options: {
	readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly init?: RequestInit | undefined;
	readonly input: string | URL | Request;
	readonly operation: ControllerRequestPolicyOperation;
	readonly timeoutMs: number;
}): Promise<Response> {
	const abortController = new AbortController();
	let callerAborted = options.init?.signal?.aborted ?? false;
	let timedOut = false;
	const abortFromCaller = (): void => {
		callerAborted = true;
		abortController.abort(options.init?.signal?.reason);
	};
	const timeout = setTimeout(() => {
		timedOut = true;
		abortController.abort(
			new Error(`${options.operation} timed out after ${String(options.timeoutMs)}ms`),
		);
	}, options.timeoutMs);
	if (callerAborted) {
		abortController.abort(options.init?.signal?.reason);
	} else {
		options.init?.signal?.addEventListener('abort', abortFromCaller, { once: true });
	}
	try {
		return await options.fetchImpl(options.input, {
			...options.init,
			signal: abortController.signal,
		});
	} catch (error) {
		if (callerAborted) {
			throw error;
		}
		throw new ControllerRequestPolicyTransportError({
			cause: error,
			code: timedOut ? 'controller-request-timeout' : 'controller-request-failed',
			operation: options.operation,
		});
	} finally {
		clearTimeout(timeout);
		options.init?.signal?.removeEventListener('abort', abortFromCaller);
	}
}

export async function fetchControllerWithPolicy(
	options: FetchControllerWithPolicyOptions,
): Promise<Response> {
	const policy = options.policy ?? controllerRequestPolicies[options.operation];
	const fetchImpl = options.fetchImpl ?? fetch;
	let lastTransportError: ControllerRequestPolicyTransportError | undefined;
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop -- controller retries must remain ordered by attempt and backoff.
			const response = await fetchWithTimeout({
				fetchImpl,
				init: options.init,
				input: options.input,
				operation: options.operation,
				timeoutMs: policy.timeoutMs,
			});
			if (attempt < policy.maxAttempts && shouldRetryResponse(response, policy)) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- drain before retrying so undici can release the response body.
				await drainControllerResponseBody(response);
				if (policy.retryBaseDelayMs > 0) {
					// oxlint-disable-next-line eslint/no-await-in-loop -- retry backoff is intentionally sequential.
					await sleep(policy.retryBaseDelayMs, options.init?.signal ?? undefined);
				}
				continue;
			}
			return response;
		} catch (error) {
			if (!(error instanceof ControllerRequestPolicyTransportError)) {
				throw error;
			}
			lastTransportError = error;
			if (!(policy.retryEnabled && attempt < policy.maxAttempts)) {
				throw error;
			}
			if (policy.retryBaseDelayMs > 0) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- retry backoff is intentionally sequential.
				await sleep(policy.retryBaseDelayMs, options.init?.signal ?? undefined);
			}
		}
	}
	throw lastTransportError ?? new Error(`${options.operation} failed without a response`);
}

export const controllerRequestPolicies = {
	'controller-health': {
		idempotency: 'read',
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		retryEnabled: false,
		retryStatuses: [],
		timeoutMs: 3_000,
	},
	'health-event-publish': {
		idempotency: 'safe-mutation',
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		retryEnabled: false,
		retryStatuses: [],
		timeoutMs: 3_000,
	},
	'openclaw-runtime-status': {
		idempotency: 'safe-mutation',
		maxAttempts: 30,
		retryBaseDelayMs: 1_000,
		retryEnabled: true,
		retryStatuses: [429, 503, 504],
		timeoutMs: 3_000,
	},
	'zone-git-push': {
		idempotency: 'unsafe-mutation',
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		retryEnabled: false,
		retryStatuses: [],
		timeoutMs: 120_000,
	},
	'lease-create': {
		idempotency: 'unsafe-mutation',
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		retryEnabled: false,
		retryStatuses: [],
		timeoutMs: 180_000,
	},
	'lease-get': {
		idempotency: 'read',
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [503, 504],
		timeoutMs: 5_000,
	},
	'lease-peek': {
		idempotency: 'read',
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [503, 504],
		timeoutMs: 5_000,
	},
	'lease-list': {
		idempotency: 'read',
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [503, 504],
		timeoutMs: 5_000,
	},
	'lease-renew': {
		idempotency: 'safe-mutation',
		maxAttempts: 3,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [429, 503, 504],
		timeoutMs: 10_000,
	},
	'lease-release': {
		idempotency: 'safe-mutation',
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [503, 504],
		timeoutMs: 5_000,
	},
	'lease-use-start': {
		idempotency: 'safe-mutation',
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [429, 503, 504],
		timeoutMs: 10_000,
	},
	'lease-heartbeat': {
		idempotency: 'safe-mutation',
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [429, 503, 504],
		timeoutMs: 5_000,
	},
	'lease-use-end': {
		idempotency: 'safe-mutation',
		maxAttempts: 2,
		retryBaseDelayMs: 250,
		retryEnabled: true,
		retryStatuses: [503, 504],
		timeoutMs: 5_000,
	},
	'worker-push-branches': {
		idempotency: 'unsafe-mutation',
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		retryEnabled: false,
		retryStatuses: [],
		timeoutMs: 120_000,
	},
	'worker-pull-default': {
		idempotency: 'unsafe-mutation',
		maxAttempts: 1,
		retryBaseDelayMs: 0,
		retryEnabled: false,
		retryStatuses: [],
		timeoutMs: 120_000,
	},
} satisfies Record<ControllerRequestPolicyOperation, ControllerRequestPolicy>;
