import { once } from 'node:events';

import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, expect, it, vi } from 'vitest';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	decodedResult,
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

afterEach(() => {
	vi.restoreAllMocks();
});

it.each([4 * 1024 * 1024 - 1, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1])(
	'enforces the old/new default response limit before redaction at %i bytes',
	async (rawBytes) => {
		vi.spyOn(Date, 'now').mockReturnValue(1792551600000);
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
		const limit = 4 * 1024 * 1024;
		const empty = {
			content: [{ type: 'text' as const, text: 'boundary' }],
			structuredContent: { token: '' },
		};
		const payloadBytes = rawBytes - Buffer.byteLength(JSON.stringify(empty));
		const token = secretCanary
			.repeat(Math.ceil(payloadBytes / secretCanary.length))
			.slice(0, payloadBytes);
		const reply = { ...empty, structuredContent: { token } };
		expect(Buffer.byteLength(JSON.stringify(reply))).toBe(rawBytes);
		alpha.setCallResult(reply);
		const args = {
			calls: [
				{ id: 'response-boundary', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } },
			],
		};

		try {
			const transport = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${oldAddress.port}/agents/agent-a/mcp`),
				{
					requestInit: {
						headers: {
							authorization: `Bearer ${deriveAgentBearerToken({ agentId: 'agent-a', credentialVersion: 1, masterKey })}`,
						},
					},
				},
			);
			const candidate: unknown = transport;
			if (!isTransport(candidate)) throw new Error('Missing v1 transport');
			await client.connect(candidate);
			const oldResult = await client.callTool({ name: 'mcp_portal_call', arguments: args });
			if (host.http === undefined) throw new Error('Missing modern listener');
			const current = await connectClient(host.http.endpoint, 'credential-a');
			try {
				const actual = await current.client.callTool({ name: 'mcp_portal_call', arguments: args });
				const { ['_meta']: metadata, ...surface } = actual;
				expect(metadata).toBeDefined();
				expect(surface).toEqual(oldResult);
				expect(decodedResult(actual).ok).toBe(rawBytes <= limit);
				expect(JSON.stringify(actual)).not.toContain(secretCanary);
				if (rawBytes <= limit) {
					expect(JSON.stringify(actual)).toContain('[REDACTED]');
					expect(Buffer.byteLength(JSON.stringify(actual))).toBeLessThan(4096);
				} else {
					expect(actual.isError).toBe(true);
					expect(JSON.stringify(actual)).toContain('upstream_call_failed');
				}
				expect(alpha.effects.map((effect) => effect.arguments)).toEqual([
					{ value: 42 },
					{ value: 42 },
				]);
				process.stdout.write(
					JSON.stringify({
						rawResponseBytes: rawBytes,
						limit,
						accepted: rawBytes <= limit,
						effects: alpha.effects.length,
					}) + '\n',
				);
			} finally {
				await current.client.close();
			}
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
	},
);
