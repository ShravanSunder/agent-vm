import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	portalRead,
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';

let harness: LocalWorkerHarness;
describe('row10 Worker protocol raw-wire controls', () => {
	beforeAll(async () => {
		harness = await startLocalWorkerHarness();
	});
	afterAll(async () => {
		await harness?.close();
	});
	it('refuses the real SDK1.29 initialize before any effect', async () => {
		const exchanges: { readonly status: number; readonly body: unknown }[] = [];
		const client = new Client({ name: 'legacy-control', version: '1' });
		const transport = new StreamableHTTPClientTransport(
			new URL(
				`http://${harness.worker.address}:${String(harness.worker.port)}/workspaces/11111111-1111-4111-8111-111111111111/mcp`,
			),
			{
				requestInit: { headers: { authorization: `Bearer ${harness.token}` } },
				// Observe the actual SDK request/response; no protocol interaction is replaced.
				fetch: async (input, init) => {
					const response = await fetch(input, init);
					exchanges.push({ status: response.status, body: await response.clone().json() });
					return response;
				},
			},
		);
		// SDK1.29's optional sessionId declaration conflicts with exactOptionalPropertyTypes.
		// Forward the real transport through its structural public interface, without a cast.
		const exactTransport: Transport = {
			start: async () => {
				transport.onmessage = (message) => exactTransport.onmessage?.(message);
				transport.onerror = (error) => exactTransport.onerror?.(error);
				await transport.start();
			},
			send: async (message, options) => transport.send(message, options),
			close: async () => transport.close(),
		};
		await expect(client.connect(exactTransport)).rejects.toThrow();
		expect(exchanges).toHaveLength(1);
		expect(exchanges[0]?.status).toBe(400);
		expect(exchanges[0]?.body).toMatchObject({
			error: { code: -32022, data: { supported: ['2026-07-28'] } },
		});
		await client.close();
		expect(harness.fixture.calls).toHaveLength(0);
	});
	it.each([
		{
			name: 'missing modern metadata',
			params: { name: 'mcp_portal_call', arguments: portalRead().arguments, _meta: undefined },
			headers: {},
			code: -32602,
		},
		{
			name: 'missing version',
			params: portalRead(),
			headers: { 'MCP-Protocol-Version': '' },
			code: -32020,
		},
		{
			name: 'mismatched version',
			params: portalRead(),
			headers: { 'MCP-Protocol-Version': '2025-11-25' },
			code: -32020,
		},
		{ name: 'missing method', params: portalRead(), headers: { 'Mcp-Method': '' }, code: -32020 },
		{
			name: 'mismatched method',
			params: portalRead(),
			headers: { 'Mcp-Method': 'tools/list' },
			code: -32020,
		},
		{ name: 'missing name', params: portalRead(), headers: { 'Mcp-Name': '' }, code: -32020 },
		{
			name: 'mismatched name',
			params: portalRead(),
			headers: { 'Mcp-Name': 'other' },
			code: -32020,
		},
	])('refuses $name without any effect', async ({ params, headers, code }) => {
		const before = harness.fixture.calls.length;
		const response = await harness.rpc('tools/call', params, { headers });
		expect(response.status).toBe(400);
		expect(
			z.object({ error: z.object({ code: z.number() }) }).parse(await response.json()).error.code,
		).toBe(code);
		expect(harness.fixture.calls).toHaveLength(before);
	});
	it.each(['', 'different-resource'])(
		'refuses resources/read with missing or mismatched Mcp-Name (%s)',
		async (name) => {
			const before = harness.fixture.calls.length;
			const response = await harness.rpc(
				'resources/read',
				{ uri: 'proof://resource' },
				{ headers: { 'Mcp-Name': name } },
			);
			expect(response.status).toBe(400);
			expect(
				z.object({ error: z.object({ code: z.number() }) }).parse(await response.json()).error.code,
			).toBe(-32020);
			expect(harness.fixture.calls).toHaveLength(before);
		},
	);
	it.each(['GET', 'DELETE'])('refuses %s with405', async (method) => {
		const response = await harness.worker.fetch(
			'/workspaces/11111111-1111-4111-8111-111111111111/mcp',
			{
				method,
				headers: { authorization: `Bearer ${harness.token}` },
			},
		);
		expect(response.status).toBe(405);
	});
	it('ignores a supplied session and emits no session ID on a valid effect', async () => {
		const before = harness.fixture.calls.length;
		const response = await harness.rpc('tools/call', portalRead(), {
			headers: { 'Mcp-Session-Id': 'arbitrary' },
		});
		expect(response.headers.get('Mcp-Session-Id')).toBeNull();
		await rpcResult(response);
		expect(harness.fixture.calls).toHaveLength(before + 1);
	});
	it('does not require Mcp-Name on discover or list', async () => {
		await Promise.all(
			['server/discover', 'tools/list'].map(async (method) => rpcResult(await harness.rpc(method))),
		);
	});
});
