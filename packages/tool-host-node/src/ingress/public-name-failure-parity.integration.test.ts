/* oxlint-disable no-await-in-loop -- These controls sequence the same live host/provider state so effects, failure changes and replay races remain attributable. */
import { once } from 'node:events';

import * as dispatch from '@agent-collaboration/tool-engine/dispatch';
import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expect, it, vi } from 'vitest';

import { nodeHostConfigSchema } from '#node-host/configuration/node-host-config';
import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	fixtureConfig,
	fixtureDirectory,
	startControlledProvider,
	toolInputSchema,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

for (const shape of ['namespace', 'tool', 'both'] as const)
	it(`retains old proxy error bytes and failed/ambiguous certainty for 10000-character public ${shape} names`, async ({
		onTestFinished,
	}) => {
		const namespace = shape === 'tool' ? 'alpha' : 'n'.repeat(10_000);
		const name = shape === 'namespace' ? 'fail' : 't'.repeat(10_000);
		const observed = new Map<string, dispatch.ResourceResult>();
		const originalFactory = dispatch.createCapabilityDispatcher;
		const observer = vi
			.spyOn(dispatch, 'createCapabilityDispatcher')
			.mockImplementation((options) => {
				const actual = originalFactory(options);
				return {
					...actual,
					dispatch: async (request) => {
						const result = await actual.dispatch(request);
						observed.set(request.item, result);
						return result;
					},
				};
			});
		onTestFinished(() => {
			observer.mockRestore();
		});
		const clock = vi.spyOn(Date, 'now').mockReturnValue(1792551600000);
		onTestFinished(() => {
			clock.mockRestore();
		});
		const provider = await startControlledProvider('long-failure', [
			{ name, inputSchema: toolInputSchema },
		]);
		provider.setCallResult({
			content: [{ type: 'text', text: 'provider explicitly failed' }],
			isError: true,
		});
		const runtime = createUpstreamMcpClientRuntime({
			servers: [{ namespace, transport: 'streamable-http', url: provider.url }],
		});
		const core = createPortalCore({
			catalogTtlMs: 60000,
			upstreamNamespaces: [namespace],
			accessPolicy: {
				enabledNamespaces: [namespace],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
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
		const masterKey = Buffer.alloc(32, 17);
		const oldApp = createPortalHttpApp({
			core,
			agentBearerAuth: { masterKey, authorizationHeaderName: 'authorization' },
			registeredAgentIds: ['agent-a'],
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? core.createAgentScope({ agentId, agentScopeId: agentId, source: 'mcp-proxy-bearer' })
					: null,
		});
		const server = serve({ fetch: oldApp.fetch, hostname: '127.0.0.1', port: 0 });
		if (!server.listening) await once(server, 'listening');
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('Missing old listener');
		const directory = await fixtureDirectory();
		const base = fixtureConfig(directory, [provider.url, provider.url]);
		const profile = base.profiles['profile-a'];
		if (profile === undefined) throw new Error('Missing profile');
		const policy = profile.profile.namespaces['alpha'];
		if (policy === undefined) throw new Error('Missing policy');
		const config = nodeHostConfigSchema.parse({
			...base,
			profiles: {
				...base.profiles,
				'profile-a': {
					...profile,
					profile: {
						...profile.profile,
						namespaces: {
							[namespace]: {
								...policy,
								calls: {
									kind: 'selectors',
									withoutApproval: { allow: [name], deny: [] },
									requiresApproval: { allow: [], deny: [] },
								},
							},
						},
					},
				},
			},
			mcp: {
				schemaVersion: 1,
				providers: {
					upstream: {
						kind: 'mcp',
						namespace,
						transport: { kind: 'streamable-http', url: provider.url },
					},
					beta: {
						kind: 'mcp',
						namespace: 'beta',
						transport: { kind: 'streamable-http', url: provider.url },
					},
				},
			},
		});
		const host = await startNodeHost({
			configPath: await writeFixtureConfig(config, directory),
			secrets: {
				resolve: async () => {
					throw new Error('No fixture secrets');
				},
			},
		});
		if (host.http === undefined) throw new Error('Missing new listener');
		const current = await connectClient(host.http.endpoint, 'credential-a');
		const old = new Client({ name: '08f9e426-long-reference', version: '1' });
		const candidate: unknown = new StreamableHTTPClientTransport(
			new URL(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`),
			{
				requestInit: {
					headers: {
						authorization: `Bearer ${deriveAgentBearerToken({ agentId: 'agent-a', credentialVersion: 1, masterKey })}`,
					},
				},
			},
		);
		if (!isTransport(candidate)) throw new Error('Missing reference transport');
		try {
			await old.connect(candidate);
			for (const id of ['tool-error', 'lost-stream']) {
				if (id === 'lost-stream') provider.breakCalls();
				const request = {
					name: 'mcp_portal_call',
					arguments: { calls: [{ id, namespace, toolName: name, arguments: { value: 42 } }] },
				};
				const expected = await old.callTool(request);
				const { _meta, ...actual } = await current.client.callTool(request);
				expect(_meta).toBeDefined();
				expect(actual).toEqual(expected);
				const encoded = JSON.stringify(actual);
				expect(encoded).toContain('upstream_call_failed');
				expect(encoded).toContain(namespace);
				expect(encoded).toContain(name);
				expect(observed.get(id)).toMatchObject({
					kind: id === 'tool-error' ? 'failed' : 'ambiguous',
					detail: {
						kind: 'mcp-upstream-failure',
						namespace,
						toolName: name,
						upstream: { namespace, toolName: name, phase: 'call_tool' },
					},
				});
				process.stdout.write(
					JSON.stringify({
						shape,
						id,
						bytes: Buffer.byteLength(encoded),
						outcome: observed.get(id)?.kind,
						effects: provider.effects.length,
					}) + '\n',
				);
			}
			expect(provider.effects).toHaveLength(4);
		} finally {
			await Promise.all([old.close(), current.client.close()]);
			await oldApp.closePortalSessions();
			await core.close();
			if ('closeAllConnections' in server) server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			);
			await host.retire();
			await provider.close();
		}
	});
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
