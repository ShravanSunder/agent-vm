import { once } from 'node:events';

import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expect, it } from 'vitest';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
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
const call = (id: string, toolName = 'read', value: unknown = 42): Record<string, unknown> => ({
	id,
	namespace: 'alpha',
	toolName,
	arguments: { value },
});
const cases = [
	{ name: 'mcp_portal_list', arguments: { requests: [{ id: 'list' }] } },
	{ name: 'mcp_portal_search', arguments: { requests: [{ id: 'search', query: 'read' }] } },
	{
		name: 'mcp_portal_describe',
		arguments: {
			requests: [
				{
					id: 'describe',
					tools: [{ namespace: 'alpha', toolName: 'read' }],
					includeTypescriptHelper: true,
				},
			],
		},
	},
	{ name: 'mcp_portal_call', arguments: { calls: [call('allowed')] } },
	{ name: 'mcp_portal_call', arguments: { calls: [] } },
	{ name: 'mcp_portal_call', arguments: { calls: [call('duplicate'), call('duplicate')] } },
	{
		name: 'mcp_portal_call',
		arguments: {
			calls: [call('z-read'), call('a-hidden', 'hidden'), call('bad-arguments', 'read', 'invalid')],
		},
	},
] satisfies readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];

for (const mode of ['indirect', 'direct'] as const) {
	it(`${mode}: keeps real Node list/search/describe/call text bytes identical to the 08f9e426 proxy`, async () => {
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
				decisionsByCallId: Object.fromEntries(calls.map((entry) => [entry.id, { kind: 'allow' }])),
			}),
			runtime: {
				listTools: runtime.listTools,
				closeAgentScope: runtime.closeAgentScope,
				callUpstreamTool: async (entry) =>
					runtime.callTool({
						agentScopeId: entry.agentScopeId,
						namespace: entry.namespace,
						toolName: entry.toolName,
						arguments: entry.arguments,
						requestId: entry.requestId,
					}),
			},
		});
		const identity = (agentId: string): ReturnType<typeof core.createAgentScope> | null =>
			agentId === 'agent-a'
				? core.createAgentScope({ agentId, agentScopeId: agentId, source: 'mcp-proxy-bearer' })
				: null;
		const oldApp = createPortalHttpApp({
			agentBearerAuth: { masterKey, authorizationHeaderName: 'authorization' },
			core,
			registeredAgentIds: ['agent-a'],
			resolveAgentIdentity: identity,
		});
		const oldServer = serve({ fetch: oldApp.fetch, hostname: '127.0.0.1', port: 0 });
		if (!oldServer.listening) await once(oldServer, 'listening');
		const oldAddress = oldServer.address();
		if (oldAddress === null || typeof oldAddress === 'string')
			throw new Error('Missing reference listener');
		const oldClient = new Client({ name: 'old-reference', version: '1' });
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
		if (host.http === undefined) throw new Error('Missing replacement listener');
		const address = new URL(host.http.endpoint);
		if (mode === 'direct') address.searchParams.set('tools', 'direct');
		const current = await connectClient(address, 'credential-a');
		const bearer = deriveAgentBearerToken({ agentId: 'agent-a', credentialVersion: 1, masterKey });
		try {
			const transport: unknown = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${oldAddress.port}/agents/agent-a/mcp`),
				{ requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
			);
			if (!isTransport(transport)) throw new Error('Missing legacy transport');
			await oldClient.connect(transport);
			await Promise.all(
				cases.map(async (request) => {
					const expected = await oldClient.callTool(request);
					const actual = await current.client.callTool(request);
					const { ['_meta']: metadata, ...surface } = actual;
					expect(metadata).toMatchObject({
						'io.modelcontextprotocol/serverInfo': { name: 'tool-host-node', version: '0.0.153' },
					});
					expect(surface, JSON.stringify(request)).toEqual(expected);
				}),
			);
			if (mode === 'direct') {
				const directApp = createPortalHttpApp({
					agentBearerAuth: { masterKey, authorizationHeaderName: 'authorization' },
					core,
					registeredAgentIds: ['agent-a'],
					resolveAgentIdentity: identity,
					catalogMode: 'catalog',
				});
				const directServer = serve({ fetch: directApp.fetch, hostname: '127.0.0.1', port: 0 });
				if (!directServer.listening) await once(directServer, 'listening');
				const directAddress = directServer.address();
				if (directAddress === null || typeof directAddress === 'string')
					throw new Error('Missing native reference listener');
				const directClient = new Client({ name: 'old-native-reference', version: '1' });
				try {
					const candidate: unknown = new StreamableHTTPClientTransport(
						new URL(`http://127.0.0.1:${directAddress.port}/agents/agent-a/mcp`),
						{ requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
					);
					if (!isTransport(candidate)) throw new Error('Missing legacy native transport');
					await directClient.connect(candidate);
					const request = { name: 'alpha__read__151160dc30', arguments: { value: 42 } };
					const { ['_meta']: metadata, ...surface } = await current.client.callTool(request);
					expect(metadata).toMatchObject({
						'io.modelcontextprotocol/serverInfo': { name: 'tool-host-node', version: '0.0.153' },
					});
					expect(surface).toEqual(await directClient.callTool(request));
				} finally {
					await directClient.close();
					await directApp.closePortalSessions();
					if ('closeAllConnections' in directServer) directServer.closeAllConnections();
					await new Promise<void>((resolve, reject) =>
						directServer.close((error) => (error === undefined ? resolve() : reject(error))),
					);
				}
			}
		} finally {
			await current.client.close();
			await oldClient.close();
			await oldApp.closePortalSessions();
			await core.close();
			if ('closeAllConnections' in oldServer) oldServer.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				oldServer.close((error) => (error === undefined ? resolve() : reject(error))),
			);
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});
}
