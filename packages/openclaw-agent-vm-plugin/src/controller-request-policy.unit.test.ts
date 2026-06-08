import { describe, expect, it, vi } from 'vitest';

import {
	ControllerRequestPolicyTransportError,
	drainControllerResponseBody,
	fetchControllerWithPolicy,
	type ControllerRequestPolicy,
	type ControllerRequestPolicyTransportErrorCode,
} from './controller-request-policy.js';
import { ControllerRequestPolicyTransportError as BarrelControllerRequestPolicyTransportError } from './index.js';

const retryDisabledPolicy = {
	idempotency: 'read',
	maxAttempts: 1,
	retryBaseDelayMs: 0,
	retryEnabled: false,
	retryStatuses: [],
	timeoutMs: 100,
} satisfies ControllerRequestPolicy;

function retryEnabledPolicy(options: {
	readonly maxAttempts: number;
	readonly retryBaseDelayMs?: number;
	readonly timeoutMs?: number;
}): ControllerRequestPolicy {
	return {
		idempotency: 'read',
		maxAttempts: options.maxAttempts,
		retryBaseDelayMs: options.retryBaseDelayMs ?? 0,
		retryEnabled: true,
		retryStatuses: [503],
		timeoutMs: options.timeoutMs ?? 100,
	};
}

describe('OpenClaw controller request policy re-export', () => {
	it('passes an AbortSignal to fetch and classifies timeout failures', async () => {
		vi.useFakeTimers();
		try {
			let capturedSignal: AbortSignal | undefined;
			const fetchImpl = vi.fn(
				async (_input: string | URL | Request, init?: RequestInit) =>
					await new Promise<Response>((_resolve, reject) => {
						capturedSignal = init?.signal ?? undefined;
						init?.signal?.addEventListener('abort', () => {
							reject(init.signal?.reason);
						});
					}),
			);

			const request = fetchControllerWithPolicy({
				fetchImpl,
				input: 'http://controller.vm.host:18800/lease/lease-1/uses/use-1/heartbeat',
				init: { method: 'POST' },
				operation: 'lease-heartbeat',
				policy: {
					...retryDisabledPolicy,
					idempotency: 'safe-mutation',
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

	it('retries transport failures within the configured attempt budget', async () => {
		const fetchImpl = vi
			.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		const response = await fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/health',
			init: { method: 'GET' },
			operation: 'controller-health',
			policy: retryEnabledPolicy({ maxAttempts: 2 }),
		});

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('aborts timed-out attempts until the configured attempt budget is exhausted', async () => {
		vi.useFakeTimers();
		try {
			const signals: AbortSignal[] = [];
			const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
				if (!init?.signal) {
					throw new Error('expected a request signal');
				}
				signals.push(init.signal);
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason);
					});
				});
			});

			const request = fetchControllerWithPolicy({
				fetchImpl,
				input: 'http://controller.vm.host:18800/health',
				init: { method: 'GET' },
				operation: 'controller-health',
				policy: retryEnabledPolicy({ maxAttempts: 2, timeoutMs: 25 }),
			});
			const rejection = expect(request).rejects.toMatchObject({
				code: 'controller-request-timeout',
				operation: 'controller-health',
			} satisfies Partial<ControllerRequestPolicyTransportError>);

			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(25);
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(25);

			await rejection;
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('applies retry backoff before retrying transport failures', async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = vi
				.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
				.mockRejectedValueOnce(new TypeError('fetch failed'))
				.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

			const request = fetchControllerWithPolicy({
				fetchImpl,
				input: 'http://controller.vm.host:18800/health',
				init: { method: 'GET' },
				operation: 'controller-health',
				policy: retryEnabledPolicy({ maxAttempts: 2, retryBaseDelayMs: 50, timeoutMs: 1_000 }),
			});

			await Promise.resolve();
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(49);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await request;

			expect(fetchImpl).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves caller cancellation without wrapping or retrying it', async () => {
		const callerAbortController = new AbortController();
		const callerError = new DOMException('cancelled by caller', 'AbortError');
		const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(init.signal?.reason);
				});
			});
		});

		const request = fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/health',
			init: { method: 'GET', signal: callerAbortController.signal },
			operation: 'controller-health',
			policy: retryEnabledPolicy({ maxAttempts: 2, timeoutMs: 1_000 }),
		});
		await Promise.resolve();
		callerAbortController.abort(callerError);

		await expect(request).rejects.toBe(callerError);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('propagates retry-looking caller cancellation without retrying', async () => {
		const callerAbortController = new AbortController();
		const callerError = new Error('fetch failed');
		const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(init.signal?.reason);
				});
			});
		});

		const request = fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/health',
			init: { method: 'GET', signal: callerAbortController.signal },
			operation: 'controller-health',
			policy: retryEnabledPolicy({ maxAttempts: 3, retryBaseDelayMs: 50, timeoutMs: 1_000 }),
		});

		await Promise.resolve();
		callerAbortController.abort(callerError);

		await expect(request).rejects.toBe(callerError);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('wraps non-timeout transport failures when retries are disabled', async () => {
		const failure = new Error('invalid request construction');
		const fetchImpl = vi
			.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
			.mockRejectedValue(failure);

		await expect(
			fetchControllerWithPolicy({
				fetchImpl,
				input: 'http://controller.vm.host:18800/health',
				init: { method: 'GET' },
				operation: 'controller-health',
				policy: retryDisabledPolicy,
			}),
		).rejects.toMatchObject({
			cause: failure,
			code: 'controller-request-failed',
			operation: 'controller-health',
		} satisfies Partial<ControllerRequestPolicyTransportError>);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('retries retryable HTTP statuses before returning success', async () => {
		const fetchImpl = vi
			.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'controller unavailable' }), { status: 503 }),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		const response = await fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/lease/lease-1/renew',
			init: { method: 'POST' },
			operation: 'lease-renew',
			policy: retryEnabledPolicy({ maxAttempts: 2 }),
		});

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it.each([
		'ECONNRESET',
		'ETIMEDOUT',
		'ECONNREFUSED',
		'EAI_AGAIN',
		'ENOTFOUND',
		'ENETUNREACH',
		'EPIPE',
	])('retries transient %s controller-link failures', async (causeCode) => {
		const fetchImpl = vi
			.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
			.mockRejectedValueOnce(new Error(`${causeCode}: controller.vm.host:18800`))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		const response = await fetchControllerWithPolicy({
			fetchImpl,
			input: 'http://controller.vm.host:18800/health',
			init: { method: 'GET' },
			operation: 'controller-health',
			policy: retryEnabledPolicy({ maxAttempts: 2 }),
		});

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('exposes a typed transport error for resilience classification', () => {
		const error = new ControllerRequestPolicyTransportError({
			cause: new Error('read ECONNRESET'),
			code: 'controller-request-failed',
			operation: 'lease-renew',
		});
		const errorCode: ControllerRequestPolicyTransportErrorCode = error.code;

		expect(error).toMatchObject({
			code: errorCode,
			name: 'Error',
			operation: 'lease-renew',
		});
		expect(errorCode).toBe('controller-request-failed');
	});

	it('exports typed controller request policy errors from the package entrypoint', () => {
		expect(
			new BarrelControllerRequestPolicyTransportError({
				cause: new Error('write EPIPE'),
				code: 'controller-request-failed',
				operation: 'controller-health',
			}),
		).toBeInstanceOf(ControllerRequestPolicyTransportError);
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

	it('drains empty and streamed response bodies', async () => {
		const emptyResponse = new Response(null, { status: 204 });
		await expect(drainControllerResponseBody(emptyResponse)).resolves.toBeUndefined();

		const streamedResponse = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('chunk-a'));
					controller.enqueue(new TextEncoder().encode('chunk-b'));
					controller.close();
				},
			}),
			{ status: 200 },
		);

		await drainControllerResponseBody(streamedResponse);

		expect(streamedResponse.bodyUsed).toBe(true);
	});

	it('treats repeated response body drains as already completed', async () => {
		const response = new Response(JSON.stringify({ ok: true }), {
			headers: { 'content-type': 'application/json' },
			status: 200,
		});

		await drainControllerResponseBody(response);
		await expect(drainControllerResponseBody(response)).resolves.toBeUndefined();

		expect(response.bodyUsed).toBe(true);
	});
});
