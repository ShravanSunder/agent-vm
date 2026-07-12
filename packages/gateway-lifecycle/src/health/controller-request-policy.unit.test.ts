import { describe, expect, it, vi } from 'vitest';

import {
	controllerRequestPolicies,
	drainControllerResponseBody,
	externalControllerRoutes,
	fetchControllerWithPolicy,
	gatewayInternalControllerRequestOperations,
	genericControllerRequestEventOperations,
	type ControllerRequestPolicy,
	type ControllerRequestPolicyTransportError,
} from './controller-request-policy.js';

type AssertControllerRequestPolicy<TPolicy extends ControllerRequestPolicy> = TPolicy;

export type ValidRetryDisabledPolicy = AssertControllerRequestPolicy<{
	readonly idempotency: 'read';
	readonly maxAttempts: 1;
	readonly retryBaseDelayMs: 0;
	readonly retryEnabled: false;
	readonly retryStatuses: readonly [];
	readonly timeoutMs: 1_000;
}>;

export type ValidRetryEnabledPolicy = AssertControllerRequestPolicy<{
	readonly idempotency: 'safe-mutation';
	readonly maxAttempts: 2;
	readonly retryBaseDelayMs: 250;
	readonly retryEnabled: true;
	readonly retryStatuses: readonly [503];
	readonly timeoutMs: 1_000;
}>;

// @ts-expect-error retry-disabled policies must not carry a retry attempt budget.
export type InvalidRetryDisabledAttemptPolicy = AssertControllerRequestPolicy<{
	readonly idempotency: 'read';
	readonly maxAttempts: 2;
	readonly retryBaseDelayMs: 0;
	readonly retryEnabled: false;
	readonly retryStatuses: readonly [];
	readonly timeoutMs: 1_000;
}>;

// @ts-expect-error retry-enabled policies must declare at least one retryable status.
export type InvalidRetryEnabledEmptyStatusesPolicy = AssertControllerRequestPolicy<{
	readonly idempotency: 'safe-mutation';
	readonly maxAttempts: 2;
	readonly retryBaseDelayMs: 250;
	readonly retryEnabled: true;
	readonly retryStatuses: readonly [];
	readonly timeoutMs: 1_000;
}>;

describe('controller request policies', () => {
	it('covers every remaining in-VM gateway controller operation', () => {
		const policyOperations = Object.keys(controllerRequestPolicies).toSorted();
		const expectedOperations = [...gatewayInternalControllerRequestOperations].toSorted();

		expect(policyOperations).toEqual(expectedOperations);
		expect(gatewayInternalControllerRequestOperations).not.toContain('lease-list');
		expect(genericControllerRequestEventOperations).not.toContain('lease-list');
		expect(controllerRequestPolicies).not.toHaveProperty('lease-list');
		expect(controllerRequestPolicies).not.toHaveProperty('worker-push-branches');
		expect(controllerRequestPolicies).not.toHaveProperty('worker-pull-default');
	});

	it('keeps external controller routes out of the in-VM policy table', () => {
		expect(externalControllerRoutes).toContain('GET /controller-status');
		expect(externalControllerRoutes).toContain('POST /zones/:zoneId/worker-tasks');
		expect(controllerRequestPolicies).not.toHaveProperty('worker-task-create');
		expect(controllerRequestPolicies).not.toHaveProperty('worker-task-close');
	});

	it('does not emit rich lease operations as generic controller-request events', () => {
		expect(genericControllerRequestEventOperations).not.toContain('lease-renew');
		expect(genericControllerRequestEventOperations).not.toContain('lease-heartbeat');
		expect(genericControllerRequestEventOperations).toContain('lease-use-start');
	});

	it('classifies unsafe mutations as single-attempt operations', () => {
		expect(controllerRequestPolicies['lease-create']).toMatchObject({
			idempotency: 'unsafe-mutation',
			maxAttempts: 1,
			retryEnabled: false,
		});
		expect(controllerRequestPolicies['zone-git-push']).toMatchObject({
			idempotency: 'unsafe-mutation',
			maxAttempts: 1,
			retryEnabled: false,
		});
	});

	it('documents lease-use-start as retryable because caller supplies a stable use id', () => {
		expect(controllerRequestPolicies['lease-use-start']).toMatchObject({
			idempotency: 'safe-mutation',
			maxAttempts: 2,
			retryEnabled: true,
		});
	});

	it('passes an AbortSignal to fetch and classifies timeout failures', async () => {
		vi.useFakeTimers();
		try {
			let capturedSignal: AbortSignal | undefined;
			const fetchImpl = vi.fn(
				async (_input: string | URL | Request, init?: RequestInit) =>
					await new Promise<Response>((_resolve, reject) => {
						capturedSignal = init?.signal ?? undefined;
						init?.signal?.addEventListener('abort', () => {
							reject(new Error('aborted by test signal'));
						});
					}),
			);

			const request = fetchControllerWithPolicy({
				fetchImpl,
				input: 'http://controller.vm.host:18800/lease/lease-1/uses/use-1/heartbeat',
				init: { method: 'POST' },
				operation: 'lease-heartbeat',
				policy: {
					idempotency: 'safe-mutation',
					maxAttempts: 1,
					retryBaseDelayMs: 0,
					retryEnabled: false,
					retryStatuses: [],
					timeoutMs: 50,
				},
			});
			const rejection = expect(request).rejects.toMatchObject({
				code: 'controller-request-timeout',
				operation: 'lease-heartbeat',
			} satisfies Partial<ControllerRequestPolicyTransportError>);

			await vi.advanceTimersByTimeAsync(50);

			await rejection;
			expect(capturedSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves caller cancellation without wrapping or retrying it', async () => {
		const callerAbort = new AbortController();
		const callerReason = new Error('caller stopped waiting');
		const fetchImpl = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason);
					});
				}),
		);

		const request = fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/lease/lease-1/renew',
			init: { method: 'POST', signal: callerAbort.signal },
			operation: 'lease-renew',
			policy: {
				idempotency: 'safe-mutation',
				maxAttempts: 2,
				retryBaseDelayMs: 0,
				retryEnabled: true,
				retryStatuses: [503],
				timeoutMs: 1_000,
			},
		});
		await Promise.resolve();
		callerAbort.abort(callerReason);

		await expect(request).rejects.toBe(callerReason);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it('aborts retry backoff immediately when the caller cancels', async () => {
		vi.useFakeTimers();
		try {
			const callerAbort = new AbortController();
			const callerReason = new Error('caller stopped during retry backoff');
			const fetchImpl = vi
				.fn<NonNullable<Parameters<typeof fetchControllerWithPolicy>[0]['fetchImpl']>>()
				.mockRejectedValueOnce(new Error('fetch failed'));

			const request = fetchControllerWithPolicy({
				fetchImpl,
				input: 'http://controller.vm.host:18800/lease/lease-1/renew',
				init: { method: 'POST', signal: callerAbort.signal },
				operation: 'lease-renew',
				policy: {
					idempotency: 'safe-mutation',
					maxAttempts: 2,
					retryBaseDelayMs: 1_000,
					retryEnabled: true,
					retryStatuses: [503],
					timeoutMs: 1_000,
				},
			});
			const rejection = expect(request).rejects.toBe(callerReason);
			await Promise.resolve();
			expect(fetchImpl).toHaveBeenCalledOnce();

			callerAbort.abort(callerReason);
			await vi.advanceTimersByTimeAsync(0);

			await rejection;
			expect(fetchImpl).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it('retries retryable HTTP statuses before returning success', async () => {
		const fetchImpl = vi
			.fn<NonNullable<Parameters<typeof fetchControllerWithPolicy>[0]['fetchImpl']>>()
			.mockResolvedValueOnce(new Response('busy', { status: 503 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		const response = await fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/lease/lease-1/renew',
			init: { method: 'POST' },
			operation: 'lease-renew',
			policy: {
				idempotency: 'safe-mutation',
				maxAttempts: 2,
				retryBaseDelayMs: 0,
				retryEnabled: true,
				retryStatuses: [503],
				timeoutMs: 1_000,
			},
		});

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('does not retry non-retryable HTTP statuses', async () => {
		const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));

		const response = await fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/lease',
			init: { method: 'POST' },
			operation: 'lease-create',
			policy: {
				idempotency: 'unsafe-mutation',
				maxAttempts: 2,
				retryBaseDelayMs: 0,
				retryEnabled: true,
				retryStatuses: [503],
				timeoutMs: 1_000,
			},
		});

		expect(response.status).toBe(400);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('drains controller response bodies for callers that ignore the body', async () => {
		const response = new Response(JSON.stringify({ ok: true }), { status: 200 });

		await drainControllerResponseBody(response);

		expect(response.bodyUsed).toBe(true);
	});
});
