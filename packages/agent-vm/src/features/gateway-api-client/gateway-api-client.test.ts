import { describe, expect, it } from 'vitest';

import { createGatewayApiClient } from './gateway-api-client.js';

describe('createGatewayApiClient', () => {
	it('checks gateway readiness via /api/status', async () => {
		const requests: { url: string; method: string }[] = [];
		const client = createGatewayApiClient({
			gatewayUrl: 'http://127.0.0.1:18791',
			token: 'test-token',
			fetchImpl: async (input, init) => {
				requests.push({
					url:
						typeof input === 'string'
							? input
							: input instanceof URL
								? input.toString()
								: input.url,
					method: init?.method ?? 'GET',
				});
				return new Response(JSON.stringify({ ok: true, version: '2026.4.2' }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				});
			},
		});

		const status = await client.getGatewayStatus();

		expect(requests[0]?.url).toBe('http://127.0.0.1:18791/api/status');
		expect(status).toMatchObject({ ok: true });
	});

	it('invokes a tool with bearer auth', async () => {
		const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
		const client = createGatewayApiClient({
			gatewayUrl: 'http://127.0.0.1:18791',
			token: 'secret-gw-token',
			fetchImpl: async (input, init) => {
				requests.push({
					url:
						typeof input === 'string'
							? input
							: input instanceof URL
								? input.toString()
								: input.url,
					headers: Object.fromEntries(new Headers(init?.headers).entries()),
					body: typeof init?.body === 'string' ? init.body : '',
				});
				return new Response(
					JSON.stringify({ ok: true, result: { output: 'file1.txt\nfile2.txt' } }),
					{ headers: { 'content-type': 'application/json' }, status: 200 },
				);
			},
		});

		const result = await client.invokeTool({
			tool: 'shell',
			args: { command: 'ls' },
			sessionKey: 'test-session',
		});

		expect(requests[0]?.url).toBe('http://127.0.0.1:18791/tools/invoke');
		expect(requests[0]?.headers['authorization']).toBe('Bearer secret-gw-token');
		expect(result).toMatchObject({ ok: true });
	});

	it('throws on non-200 response from tools/invoke', async () => {
		const client = createGatewayApiClient({
			gatewayUrl: 'http://127.0.0.1:18791',
			token: 'test-token',
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
		});

		await expect(
			client.invokeTool({ tool: 'shell', args: { command: 'ls' } }),
		).rejects.toThrow('Gateway API returned status 401');
	});

	it('strips trailing slash from gateway url', async () => {
		const requests: string[] = [];
		const client = createGatewayApiClient({
			gatewayUrl: 'http://127.0.0.1:18791/',
			token: 'test-token',
			fetchImpl: async (input) => {
				requests.push(
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.toString()
							: input.url,
				);
				return new Response(JSON.stringify({ ok: true }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				});
			},
		});

		await client.getGatewayStatus();

		expect(requests[0]).toBe('http://127.0.0.1:18791/api/status');
	});
});
