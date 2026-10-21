import { once } from 'node:events';

import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	decodedResult,
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

function isTransport(value: unknown): value is Transport {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'send' in value &&
		typeof value.send === 'function' &&
		'close' in value &&
		typeof value.close === 'function'
	);
}

it('delivers a serialized proxy request over 4 MiB through both the unchanged 08f9e426 Node route and the modern replacement', async () => {
	const directory = await fixtureDirectory();
	const alpha = await startControlledProvider('alpha');
	const beta = await startControlledProvider('beta');
	const masterKey = Buffer.alloc(32, 17);
	const runtime = createUpstreamMcpClientRuntime({
		servers: [{ namespace: 'alpha', transport: 'streamable-http', url: alpha.url }],
		additionalRedactionValues: [secretCanary, headerCanary],
	});
	const core = createPortalCore({
		catalogTtlMs: 60_000,
		upstreamNamespaces: ['alpha'],
		accessPolicy: {
			enabledNamespaces: ['alpha'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {
				'agent-a': [
					{ namespace: 'alpha', toolName: 'hidden' },
					{ namespace: 'alpha', toolName: 'blocked' },
				],
			},
		},
		approval: (calls) => ({
			decisionsByCallId: Object.fromEntries(calls.map((call) => [call.id, { kind: 'allow' }])),
		}),
		runtime: {
			listTools: runtime.listTools,
			closeAgentScope: runtime.closeAgentScope,
			callUpstreamTool: async (call) =>
				runtime.callTool({
					agentScopeId: call.agentScopeId,
					namespace: call.namespace,
					toolName: call.toolName,
					arguments: call.arguments,
					requestId: call.requestId,
				}),
		},
	});
	const app = createPortalHttpApp({
		agentBearerAuth: { masterKey, authorizationHeaderName: 'authorization' },
		core,
		registeredAgentIds: ['agent-a'],
		resolveAgentIdentity: (agentId) =>
			agentId === 'agent-a'
				? core.createAgentScope({ agentId, agentScopeId: agentId, source: 'mcp-proxy-bearer' })
				: null,
	});
	const oldServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
	if (!oldServer.listening) await once(oldServer, 'listening');
	const oldAddress = oldServer.address();
	if (oldAddress === null || typeof oldAddress === 'string')
		throw new Error('Missing reference listener');
	const client = new Client({ name: 'old-large-request-control', version: '1.0.0' });
	const configPath = await writeFixtureConfig(
		fixtureConfig(directory, [alpha.url, beta.url]),
		directory,
	);
	const host = await startNodeHost({
		configPath,
		secrets: {
			resolve: async (secret): Promise<string> =>
				secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
					? secretCanary
					: headerCanary,
		},
	});
	const padding = 'x'.repeat(4 * 1024 * 1024 + 1);
	const args = {
		calls: [{ id: 'large', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } }],
	};
	let oldBytes = 0;
	try {
		const transport = new StreamableHTTPClientTransport(
			new URL(`http://127.0.0.1:${oldAddress.port}/agents/agent-a/mcp`),
			{
				requestInit: {
					headers: {
						authorization: `Bearer ${deriveAgentBearerToken({ agentId: 'agent-a', credentialVersion: 1, masterKey })}`,
					},
				},
				fetch: async (input, init): Promise<Response> => {
					if (typeof init?.body === 'string')
						oldBytes = Math.max(oldBytes, Buffer.byteLength(init.body));
					return fetch(input, init);
				},
			},
		);
		const candidate: unknown = transport;
		if (!isTransport(candidate)) throw new Error('Missing v1 transport');
		await client.connect(candidate);
		const oldResult = await client.callTool({
			name: 'mcp_portal_call',
			arguments: args,
			_meta: { 'example.com/padding': padding },
		});
		expect(oldResult.isError).not.toBe(true);
		expect(oldBytes).toBeGreaterThan(4 * 1024 * 1024);
		expect(alpha.effects.map((effect) => effect.arguments)).toEqual([{ value: 42 }]);
		if (host.http === undefined) throw new Error('Missing new listener');
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 91,
			method: 'tools/call',
			params: {
				name: 'mcp_portal_call',
				arguments: args,
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: '2026-07-28',
					[CLIENT_CAPABILITIES_META_KEY]: {},
					'example.com/padding': padding,
				},
			},
		});
		expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024);
		const response = await fetch(host.http.endpoint, {
			method: 'POST',
			headers: {
				authorization: 'Bearer credential-a',
				accept: 'application/json, text/event-stream',
				'content-type': 'application/json',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'mcp_portal_call',
			},
			body,
		});
		expect(response.status).toBe(200);
		expect(
			decodedResult(z.object({ result: z.unknown() }).parse(await response.json()).result).ok,
		).toBe(true);
		expect(alpha.effects.map((effect) => effect.arguments)).toEqual([{ value: 42 }, { value: 42 }]);
		process.stdout.write(
			JSON.stringify({
				oldBytes,
				newBytes: Buffer.byteLength(body),
				effects: alpha.effects.length,
			}) + '\n',
		);
	} finally {
		await client.close();
		await app.closePortalSessions();
		await core.close();
		if ('closeAllConnections' in oldServer) oldServer.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			oldServer.close((error) => (error === undefined ? resolve() : reject(error))),
		);
		await host.retire();
		await Promise.all([alpha.close(), beta.close()]);
	}
});
