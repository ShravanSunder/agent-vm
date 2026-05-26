import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
	ControllerRequestFailureError,
	ControllerRequestTimeoutError,
	drainControllerResponseBody,
	fetchControllerWithPolicy,
	type ControllerRequestCauseCode,
} from './controller-request-policy.js';
import {
	ControllerRequestFailureError as BarrelControllerRequestFailureError,
	ControllerRequestTimeoutError as BarrelControllerRequestTimeoutError,
} from './index.js';

async function listenOnLoopback(server: Server): Promise<number> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Expected TCP server address.');
	}
	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	server.close();
	await once(server, 'close');
}

describe('controller request policy', () => {
	it('retries transient controller fetch failures within the configured attempt budget', async () => {
		const fetchImpl = vi
			.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		const response = await fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
			fetchImpl,
			method: 'GET',
			operation: 'gateway-control-link',
			policy: {
				maxAttempts: 2,
				retryBaseDelayMs: 0,
				timeoutMs: 100,
			},
		});

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('aborts timed-out attempts until the configured attempt budget is exhausted', async () => {
		vi.useFakeTimers();
		try {
			const signals: AbortSignal[] = [];
			let settledError: unknown;
			const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
				if (!init?.signal) {
					throw new Error('expected a request signal');
				}
				signals.push(init.signal);
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => {
						reject(new DOMException('The operation was aborted.', 'AbortError'));
					});
				});
			});

			void fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
				fetchImpl,
				method: 'GET',
				operation: 'gateway-control-link',
				policy: {
					maxAttempts: 2,
					retryBaseDelayMs: 0,
					timeoutMs: 25,
				},
			}).catch((error: unknown) => {
				settledError = error;
			});

			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(25);
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(25);
			await Promise.resolve();

			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(settledError).toMatchObject({
				attempt: 2,
				elapsedMs: 50,
				maxAttempts: 2,
				name: 'ControllerRequestTimeoutError',
				operation: 'gateway-control-link',
				timeoutMs: 25,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('applies retry backoff before retrying transient failures', async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = vi
				.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
				.mockRejectedValueOnce(new TypeError('fetch failed'))
				.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

			const request = fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
				fetchImpl,
				method: 'GET',
				operation: 'gateway-control-link',
				policy: {
					maxAttempts: 2,
					retryBaseDelayMs: 50,
					timeoutMs: 1_000,
				},
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

	it('propagates caller cancellation without retrying or rewriting it as a timeout', async () => {
		vi.useFakeTimers();
		const callerAbortController = new AbortController();
		const callerError = new DOMException('cancelled by caller', 'AbortError');
		const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted.', 'AbortError'));
				});
			});
		});

		try {
			const request = fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
				fetchImpl,
				method: 'GET',
				operation: 'gateway-control-link',
				policy: {
					maxAttempts: 2,
					retryBaseDelayMs: 0,
					timeoutMs: 1_000,
				},
				signal: callerAbortController.signal,
			});

			await Promise.resolve();
			callerAbortController.abort(callerError);

			await expect(request).rejects.toBe(callerError);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('propagates retry-looking caller cancellation without retry backoff', async () => {
		vi.useFakeTimers();
		const callerAbortController = new AbortController();
		const callerError = new Error('fetch failed');
		const sleepImpl = vi.fn(async () => {});
		const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted.', 'AbortError'));
				});
			});
		});

		try {
			const request = fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
				fetchImpl,
				method: 'GET',
				operation: 'gateway-control-link',
				policy: {
					maxAttempts: 3,
					retryBaseDelayMs: 50,
					timeoutMs: 1_000,
				},
				signal: callerAbortController.signal,
				sleepImpl,
			});

			await Promise.resolve();
			callerAbortController.abort(callerError);

			await expect(request).rejects.toBe(callerError);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(sleepImpl).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not retry non-transient controller request failures', async () => {
		const failure = new Error('invalid request construction');
		const fetchImpl = vi
			.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
			.mockRejectedValue(failure);

		await expect(
			fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
				fetchImpl,
				method: 'GET',
				operation: 'gateway-control-link',
				policy: {
					maxAttempts: 3,
					retryBaseDelayMs: 0,
					timeoutMs: 100,
				},
			}),
		).rejects.toBe(failure);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('does not retry HTTP responses because the request reached the controller', async () => {
		const fetchImpl = vi
			.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
			.mockResolvedValue(
				new Response(JSON.stringify({ error: 'controller unavailable' }), { status: 503 }),
			);

		const response = await fetchControllerWithPolicy('http://controller.vm.host:18800/lease', {
			fetchImpl,
			method: 'POST',
			operation: 'lease-request',
			policy: {
				maxAttempts: 3,
				retryBaseDelayMs: 0,
				timeoutMs: 100,
			},
		});

		expect(response.status).toBe(503);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
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

		const response = await fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
			fetchImpl,
			method: 'GET',
			operation: 'gateway-control-link',
			policy: {
				maxAttempts: 2,
				retryBaseDelayMs: 0,
				timeoutMs: 100,
			},
		});

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('classifies exhausted controller-link transport failures for health reporting', async () => {
		const transportError = Object.assign(new Error('connect ETIMEDOUT 198.19.42.7:18800'), {
			code: 'ETIMEDOUT',
		});
		const fetchImpl = vi.fn(async () => {
			throw transportError;
		});

		await expect(
			fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
				fetchImpl,
				method: 'GET',
				operation: 'active-use-heartbeat',
				policy: {
					maxAttempts: 2,
					retryBaseDelayMs: 0,
					timeoutMs: 100,
				},
			}),
		).rejects.toMatchObject({
			attempt: 2,
			causeCode: 'ETIMEDOUT',
			maxAttempts: 2,
			name: 'ControllerRequestFailureError',
			operation: 'active-use-heartbeat',
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('exposes a typed timeout error for resilience classification', async () => {
		const error = new ControllerRequestTimeoutError({
			operation: 'active-use-heartbeat',
			timeoutMs: 3_000,
		});

		expect(error).toMatchObject({
			attempt: 1,
			elapsedMs: 3_000,
			maxAttempts: 1,
			name: 'ControllerRequestTimeoutError',
			operation: 'active-use-heartbeat',
			timeoutMs: 3_000,
		});
	});

	it('exposes a typed transport error for resilience classification', () => {
		const error = new ControllerRequestFailureError({
			attempt: 3,
			cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
			maxAttempts: 3,
			operation: 'lease-renew',
		});
		const causeCode: ControllerRequestCauseCode | undefined = error.causeCode;

		expect(error).toMatchObject({
			attempt: 3,
			causeCode,
			maxAttempts: 3,
			name: 'ControllerRequestFailureError',
			operation: 'lease-renew',
		});
		expect(causeCode).toBe('ECONNRESET');
	});

	it('exports typed controller request policy errors from the package entrypoint', () => {
		expect(
			new BarrelControllerRequestTimeoutError({
				operation: 'gateway-control-link',
				timeoutMs: 3_000,
			}),
		).toBeInstanceOf(ControllerRequestTimeoutError);
		expect(
			new BarrelControllerRequestFailureError({
				attempt: 1,
				cause: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
				maxAttempts: 1,
				operation: 'gateway-control-link',
			}),
		).toBeInstanceOf(ControllerRequestFailureError);
	});

	it('clears request timers after successful and failed attempts', async () => {
		const clearTimeoutImpl = vi.fn<(timeout: ReturnType<typeof setTimeout>) => void>();
		const timeoutHandle = 42 as unknown as ReturnType<typeof setTimeout>;
		const setTimeoutImpl = vi.fn((_callback: () => void, _delayMs?: number) => timeoutHandle);
		const successFetch = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);

		await fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
			clearTimeoutImpl,
			fetchImpl: successFetch,
			method: 'GET',
			operation: 'gateway-control-link',
			policy: {
				maxAttempts: 1,
				retryBaseDelayMs: 0,
				timeoutMs: 100,
			},
			setTimeoutImpl,
		});

		expect(clearTimeoutImpl).toHaveBeenCalledWith(timeoutHandle);

		const failure = new Error('invalid request construction');
		const failedFetch = vi.fn(async () => {
			throw failure;
		});

		await expect(
			fetchControllerWithPolicy('http://controller.vm.host:18800/health', {
				clearTimeoutImpl,
				fetchImpl: failedFetch,
				method: 'GET',
				operation: 'gateway-control-link',
				policy: {
					maxAttempts: 1,
					retryBaseDelayMs: 0,
					timeoutMs: 100,
				},
				setTimeoutImpl,
			}),
		).rejects.toBe(failure);

		expect(clearTimeoutImpl).toHaveBeenCalledWith(timeoutHandle);
		expect(clearTimeoutImpl).toHaveBeenCalledTimes(2);
	});

	it('drains successful response bodies', async () => {
		const response = new Response(JSON.stringify({ ok: true }), {
			headers: { 'content-type': 'application/json' },
			status: 200,
		});

		expect(response.bodyUsed).toBe(false);
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

	it('surfaces response body drain failures', async () => {
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new Error('stream failed'));
				},
			}),
			{ status: 200 },
		);

		await expect(drainControllerResponseBody(response)).rejects.toThrow('stream failed');
	});

	it('aborts a real Node fetch when the controller accepts but never responds', async () => {
		const server = createServer((_request, _response) => {
			// Leave the response open to simulate a stalled controller link.
		});
		const port = await listenOnLoopback(server);

		try {
			await expect(
				fetchControllerWithPolicy(`http://127.0.0.1:${String(port)}/health`, {
					fetchImpl: fetch,
					method: 'GET',
					operation: 'gateway-control-link',
					policy: {
						maxAttempts: 1,
						retryBaseDelayMs: 0,
						timeoutMs: 25,
					},
				}),
			).rejects.toMatchObject({
				attempt: 1,
				maxAttempts: 1,
				name: 'ControllerRequestTimeoutError',
				operation: 'gateway-control-link',
				timeoutMs: 25,
			});
		} finally {
			await closeServer(server);
		}
	});
});
