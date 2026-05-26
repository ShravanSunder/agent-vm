import { describe, expect, it, vi } from 'vitest';

import {
	drainControllerResponseBody,
	fetchControllerWithPolicy,
	type ControllerRequestPolicyTransportError,
} from './controller-request-policy.js';

describe('OpenClaw controller request policy', () => {
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
