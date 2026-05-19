import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';

import { createPortalCore, type PortalCore } from '../core/portal-core.js';
import {
	createPortalAgentIdentity as createPortalAgentIdentityBase,
	type PortalAgentIdentity,
} from '../portal-access-policy.js';
import { deriveAgentBearerToken } from '../portal-auth/agent-bearer-token.js';
import { createPortalHttpApp } from './portal-http-server.js';

const masterKey = Buffer.from('master-key');

function createPortalAgentIdentity(
	input: Omit<Parameters<typeof createPortalAgentIdentityBase>[0], 'source'>,
): PortalAgentIdentity {
	return createPortalAgentIdentityBase({ ...input, source: 'mcp-proxy-bearer' });
}

function bearerAuthHeader(agentId: string): string {
	return `Bearer ${deriveAgentBearerToken({ agentId, masterKey })}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstTextContent(value: unknown): string {
	if (!isObjectRecord(value) || !Array.isArray(value.content)) {
		return '';
	}
	const firstContent = value.content[0];
	if (!isObjectRecord(firstContent) || firstContent.type !== 'text') {
		return '';
	}
	return typeof firstContent.text === 'string' ? firstContent.text : '';
}

function asClientTransport(transport: StreamableHTTPClientTransport): Transport {
	return transport as unknown as Transport;
}

function allowApproval(): { readonly kind: 'allow' } {
	return { kind: 'allow' };
}

function createTestPortalCore(
	props: {
		readonly seenAgentScopeIds?: string[];
	} = {},
): PortalCore {
	return createPortalCore({
		accessPolicy: {
			defaultPolicy: 'deny-all',
			enabledNamespacesByAgent: { 'agent-a': ['linear'] },
			enabledToolsByAgent: {},
			hiddenToolsByAgent: {},
		},
		approval: allowApproval,
		catalogTtlMs: 60_000,
		runtime: {
			callUpstreamTool: async () => ({}),
			closeAgentScope: () => undefined,
			listTools: async ({ agentScopeId }) => {
				props.seenAgentScopeIds?.push(agentScopeId);
				return [
					{
						inputSchema: { properties: {}, type: 'object' },
						name: 'search_issues',
					},
				];
			},
		},
		upstreamNamespaces: ['linear'],
	});
}

describe('portal HTTP server', () => {
	it('GET /health returns registered agent ids', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore(),
			registeredAgentIds: ['agent-b', 'agent-a'],
		});

		const response = await app.request('/health');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ agents: ['agent-a', 'agent-b'], ok: true });
	});

	it('refuses to construct agent MCP routes without bearer auth', () => {
		expect(() =>
			// @ts-expect-error Intentional runtime guard coverage for JavaScript callers.
			createPortalHttpApp({
				core: createTestPortalCore(),
				resolveAgentIdentity: (agentId) =>
					agentId === 'agent-a'
						? createPortalAgentIdentity({
								agentId: 'agent-a',
								agentScopeId: 'agent-a',
							})
						: null,
			}),
		).toThrow(/agent bearer auth/u);
	});

	it('requires the configured bearer header before handling agent MCP requests', async () => {
		const customHeaderName = 'x-mcp-portal-bearer';
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: customHeaderName, masterKey },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});

		await expect(app.request('/agents/agent-a/mcp')).resolves.toMatchObject({
			status: 401,
		});
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { [customHeaderName]: bearerAuthHeader('agent-a') },
			}),
		).resolves.not.toMatchObject({ status: 401 });
	});

	it('requires the derived agent bearer when bearer auth is configured', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});

		await expect(app.request('/agents/agent-a/mcp')).resolves.toMatchObject({ status: 401 });
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: {
					authorization: bearerAuthHeader('agent-b'),
				},
			}),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: {
					authorization: bearerAuthHeader('agent-a'),
				},
			}),
		).resolves.not.toMatchObject({ status: 401 });
	});

	it('serves initialize, tools/list, and tools/call through Streamable HTTP', async () => {
		const seenAgentScopeIds: string[] = [];
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore({ seenAgentScopeIds }),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});
		const server = serve({ fetch: app.fetch, port: 0 });
		try {
			const address = server.address() as AddressInfo;
			const transport = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`),
				{ requestInit: { headers: { authorization: bearerAuthHeader('agent-a') } } },
			);
			const client = new Client({ name: 'portal-http-test', version: '1.0.0' });
			await client.connect(asClientTransport(transport));

			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toContain('mcp_portal_list');

			const result = await client.callTool({
				arguments: { requests: [{ id: 'list-linear', limit: 10 }] },
				name: 'mcp_portal_list',
			});
			const text = firstTextContent(result);
			expect(JSON.parse(text)).toMatchObject({
				structuredContent: {
					ok: true,
					results: {
						'list-linear': {
							ok: true,
							output: {
								namespaces: ['linear'],
								tools: [
									expect.objectContaining({ namespace: 'linear', toolName: 'search_issues' }),
								],
							},
						},
					},
				},
			});
			expect(seenAgentScopeIds).toEqual([expect.stringContaining('agent-a')]);
		} finally {
			if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
				server.closeAllConnections();
			}
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		}
	});

	it('force-closes active sessions so reloaded runtimes make clients reconnect', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});
		const server = serve({ fetch: app.fetch, port: 0 });
		try {
			const address = server.address() as AddressInfo;
			const transport = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`),
				{ requestInit: { headers: { authorization: bearerAuthHeader('agent-a') } } },
			);
			const client = new Client({ name: 'portal-http-test', version: '1.0.0' });
			await client.connect(asClientTransport(transport));
			const sessionId = transport.sessionId;
			if (!sessionId) {
				throw new Error('MCP session id was not captured');
			}

			await expect(app.request('/mcp-portal/sessions', { method: 'PURGE' })).resolves.toMatchObject(
				{
					status: 404,
				},
			);
			await app.closePortalSessions();
			await expect(
				app.request('/agents/agent-a/mcp', {
					headers: {
						authorization: bearerAuthHeader('agent-a'),
						'mcp-session-id': sessionId,
					},
				}),
			).resolves.toMatchObject({ status: 404 });

			try {
				await client.close();
			} catch {
				// The server-side purge intentionally closes the transport out from under the client.
			}
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		}
	});

	it('attempts every active session close before surfacing close errors', async () => {
		let closeCallbackCount = 0;
		const closedSessionIds: string[] = [];
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore(),
			onSessionClosed: async (identity) => {
				closeCallbackCount += 1;
				if (closeCallbackCount === 1) {
					closedSessionIds.push(identity.sessionId ?? 'missing-session-id');
					throw new Error('first close failed');
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
				closedSessionIds.push(identity.sessionId ?? 'missing-session-id');
			},
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});
		const server = serve({ fetch: app.fetch, port: 0 });
		let clients: Client[] = [];
		try {
			const address = server.address() as AddressInfo;
			clients = await Promise.all(
				['portal-http-test-a', 'portal-http-test-b'].map(async (clientName) => {
					const transport = new StreamableHTTPClientTransport(
						new URL(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`),
						{ requestInit: { headers: { authorization: bearerAuthHeader('agent-a') } } },
					);
					const client = new Client({ name: clientName, version: '1.0.0' });
					await client.connect(asClientTransport(transport));
					return client;
				}),
			);

			await expect(app.closePortalSessions()).rejects.toThrow(
				/Failed to close one or more MCP Portal sessions/u,
			);
			expect(closedSessionIds).toHaveLength(2);
		} finally {
			await Promise.allSettled(clients.map(async (client) => await client.close()));
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		}
	});
});
