import { describe, expect, it, vi } from 'vitest';

import { createGatewayObservabilityOtlpRequestMediation } from './gateway-observability-otlp-request-mediation.js';

const syntheticCollectorHost = 'otel-collector.observability.vm.host';
const syntheticCollectorPort = 4318;
const targetCollectorHost = '127.0.0.1';
const targetCollectorPort = 14_318;

function createMediationOptions(
	overrides: {
		readonly createDeadlineSignal?: (timeoutMs: number) => AbortSignal;
		readonly fetchImpl?: typeof fetch;
	} = {},
): Parameters<typeof createGatewayObservabilityOtlpRequestMediation>[0] {
	return {
		collector: {
			host: syntheticCollectorHost,
			httpPort: syntheticCollectorPort,
			targetHost: targetCollectorHost,
			targetHttpPort: targetCollectorPort,
		},
		...overrides,
	};
}

function createOtlpRequest(pathname: '/v1/traces' | '/v1/metrics' | '/v1/logs'): Request {
	return new Request(
		`http://${syntheticCollectorHost}:${String(syntheticCollectorPort)}${pathname}`,
		{
			body: new Uint8Array([1, 2, 3]),
			headers: {
				authorization: 'Bearer guest-credential-must-not-forward',
				baggage: 'guest-baggage-must-not-forward',
				cookie: 'session=guest-cookie-must-not-forward',
				'content-type': 'application/x-protobuf',
				forwarded: 'for=guest',
				'proxy-authorization': 'Basic guest-proxy-credential',
				traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
				'x-forwarded-for': '127.0.0.1',
			},
			method: 'POST',
		},
	);
}

function createRequestWithDefensiveUrl(url: string): Request {
	const request = createOtlpRequest('/v1/traces');
	Object.defineProperty(request, 'url', { configurable: true, value: url });
	return request;
}

describe('createGatewayObservabilityOtlpRequestMediation', () => {
	it.each(['/v1/traces', '/v1/metrics', '/v1/logs'] as const)(
		'forwards exact %s protobuf requests once and sanitizes both directions',
		async (pathname) => {
			const fetchImpl = vi.fn<typeof fetch>(
				async () =>
					new Response(new Uint8Array([9, 8, 7]), {
						headers: {
							connection: 'keep-alive',
							'content-encoding': 'gzip',
							'content-length': '999',
							'content-type': 'application/x-protobuf',
							'retry-after': '3',
							'set-cookie': 'controller-cookie=must-not-return',
							'x-controller-internal': 'must-not-return',
						},
						status: 200,
					}),
			);
			const createDeadlineSignal = vi.fn((_timeoutMs: number) => new AbortController().signal);
			const mediate = createGatewayObservabilityOtlpRequestMediation(
				createMediationOptions({ createDeadlineSignal, fetchImpl }),
			);

			const response = await mediate(createOtlpRequest(pathname));

			expect(response).toBeInstanceOf(Response);
			expect(response?.status).toBe(200);
			expect(new Uint8Array(await (response as Response).arrayBuffer())).toEqual(
				new Uint8Array([9, 8, 7]),
			);
			expect(Object.fromEntries((response as Response).headers)).toEqual({
				'content-type': 'application/x-protobuf',
				'retry-after': '3',
			});
			expect(createDeadlineSignal).toHaveBeenCalledExactlyOnceWith(5_000);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			const [target, requestInit] = fetchImpl.mock.calls[0] ?? [];
			expect(target).toBe(
				`http://${targetCollectorHost}:${String(targetCollectorPort)}${pathname}`,
			);
			expect(requestInit).toEqual(
				expect.objectContaining({
					body: expect.any(ReadableStream),
					duplex: 'half',
					headers: new Headers({ 'content-type': 'application/x-protobuf' }),
					method: 'POST',
					redirect: 'manual',
					signal: expect.any(AbortSignal),
				}),
			);
			const forwardedHeaders = new Headers(requestInit?.headers);
			expect(Object.fromEntries(forwardedHeaders)).toEqual({
				'content-type': 'application/x-protobuf',
			});
			const forwardedBody = requestInit?.body as ReadableStream<Uint8Array>;
			expect(new Uint8Array(await new Response(forwardedBody).arrayBuffer())).toEqual(
				new Uint8Array([1, 2, 3]),
			);
		},
	);

	it.each([
		{
			expectedStatus: 400,
			label: 'non-http protocol',
			request: new Request(
				`https://${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/traces`,
				{
					body: 'payload',
					headers: { 'content-type': 'application/x-protobuf' },
					method: 'POST',
				},
			),
		},
		{
			expectedStatus: 405,
			label: 'non-POST method',
			request: new Request(
				`http://${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/traces`,
			),
		},
		{
			expectedStatus: 404,
			label: 'unknown path',
			request: new Request(
				`http://${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/unknown`,
				{
					body: 'payload',
					headers: { 'content-type': 'application/x-protobuf' },
					method: 'POST',
				},
			),
		},
		{
			expectedStatus: 400,
			label: 'query',
			request: new Request(
				`http://${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/traces?redirect=http://127.0.0.1`,
				{
					body: 'payload',
					headers: { 'content-type': 'application/x-protobuf' },
					method: 'POST',
				},
			),
		},
		{
			expectedStatus: 400,
			label: 'fragment',
			request: new Request(
				`http://${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/traces#fragment`,
				{
					body: 'payload',
					headers: { 'content-type': 'application/x-protobuf' },
					method: 'POST',
				},
			),
		},
		{
			expectedStatus: 400,
			label: 'userinfo',
			request: createRequestWithDefensiveUrl(
				`http://guest:password@${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/traces`,
			),
		},
		{
			expectedStatus: 415,
			label: 'non-protobuf content type',
			request: new Request(
				`http://${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/traces`,
				{
					body: 'payload',
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				},
			),
		},
		{
			expectedStatus: 415,
			label: 'content encoding',
			request: new Request(
				`http://${syntheticCollectorHost}:${String(syntheticCollectorPort)}/v1/traces`,
				{
					body: 'payload',
					headers: {
						'content-encoding': 'gzip',
						'content-type': 'application/x-protobuf',
					},
					method: 'POST',
				},
			),
		},
	])(
		'rejects exact collector authority request with $label',
		async ({ expectedStatus, request }) => {
			const fetchImpl = vi.fn<typeof fetch>();
			const mediate = createGatewayObservabilityOtlpRequestMediation(
				createMediationOptions({ fetchImpl }),
			);

			const response = await mediate(request);

			expect(response).toBeInstanceOf(Response);
			expect(response?.status).toBe(expectedStatus);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it.each([
		`http://other.vm.host:${String(syntheticCollectorPort)}/v1/traces`,
		`http://${syntheticCollectorHost}:4319/v1/traces`,
	])('leaves unrelated authority %s in normal mediation', async (requestUrl) => {
		const fetchImpl = vi.fn<typeof fetch>();
		const mediate = createGatewayObservabilityOtlpRequestMediation(
			createMediationOptions({ fetchImpl }),
		);

		const response = await mediate(
			new Request(requestUrl, {
				body: 'payload',
				headers: { 'content-type': 'application/x-protobuf' },
				method: 'POST',
			}),
		);

		expect(response).toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('denies direct access to the configured loopback collector authority', async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const mediate = createGatewayObservabilityOtlpRequestMediation(
			createMediationOptions({ fetchImpl }),
		);

		const response = await mediate(
			new Request(`http://${targetCollectorHost}:${String(targetCollectorPort)}/v1/traces`, {
				body: 'direct-target-payload',
				headers: { 'content-type': 'application/x-protobuf' },
				method: 'POST',
			}),
		);

		expect(response).toBeInstanceOf(Response);
		expect(response?.status).toBe(403);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each(['localhost', '10.0.0.1', 'collector.internal'])(
		'rejects non-loopback configured target host %s at construction',
		(targetHost) => {
			expect(() =>
				createGatewayObservabilityOtlpRequestMediation({
					collector: {
						host: syntheticCollectorHost,
						httpPort: syntheticCollectorPort,
						targetHost,
						targetHttpPort: targetCollectorPort,
					},
				}),
			).toThrow('targetHost must be loopback');
		},
	);

	it('accepts bracketed IPv6 loopback and builds an exact trusted target URL', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mediate = createGatewayObservabilityOtlpRequestMediation({
			collector: {
				host: syntheticCollectorHost,
				httpPort: syntheticCollectorPort,
				targetHost: '[::1]',
				targetHttpPort: targetCollectorPort,
			},
			fetchImpl,
		});

		const response = await mediate(createOtlpRequest('/v1/traces'));

		expect(response?.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(
			`http://[::1]:${String(targetCollectorPort)}/v1/traces`,
		);
	});

	it('does not follow redirects and returns a sanitized 502 response', async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response('redirect body', {
					headers: { location: 'http://127.0.0.1:9999/secret' },
					status: 307,
				}),
		);
		const mediate = createGatewayObservabilityOtlpRequestMediation(
			createMediationOptions({ fetchImpl }),
		);

		const response = await mediate(createOtlpRequest('/v1/traces'));

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
		expect(response).toBeInstanceOf(Response);
		expect(response?.status).toBe(502);
		expect(Object.fromEntries((response as Response).headers)).toEqual({});
	});

	it('returns 504 after one deadline abort and never retries', async () => {
		const deadlineController = new AbortController();
		const deadlineAbortListener = vi.fn();
		deadlineController.signal.addEventListener('abort', deadlineAbortListener);
		const createDeadlineSignal = vi.fn((_timeoutMs: number) => deadlineController.signal);
		const fetchImpl = vi.fn<typeof fetch>(async (_input, requestInit) => {
			deadlineController.abort(new DOMException('deadline', 'TimeoutError'));
			throw requestInit?.signal?.reason;
		});
		const mediate = createGatewayObservabilityOtlpRequestMediation(
			createMediationOptions({ createDeadlineSignal, fetchImpl }),
		);

		const response = await mediate(createOtlpRequest('/v1/metrics'));

		expect(createDeadlineSignal).toHaveBeenCalledExactlyOnceWith(5_000);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(deadlineController.signal.aborted).toBe(true);
		expect(deadlineAbortListener).toHaveBeenCalledOnce();
		expect(response).toBeInstanceOf(Response);
		expect(response?.status).toBe(504);
	});

	it('returns 502 on transport failure without retrying', async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new TypeError('connection refused');
		});
		const mediate = createGatewayObservabilityOtlpRequestMediation(
			createMediationOptions({ fetchImpl }),
		);

		const response = await mediate(createOtlpRequest('/v1/logs'));

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(response).toBeInstanceOf(Response);
		expect(response?.status).toBe(502);
	});
});
