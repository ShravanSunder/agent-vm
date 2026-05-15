import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';

import { createPortalAgentIdentity, type PortalAgentIdentity } from '../portal-access-policy.js';
import type { PortalSession } from '../portal-session.js';
import { createPortalHttpApp } from './portal-http-server.js';

const session = {
	catalog: {
		agentScopeId: 'agent-scope-a',
		discoveryFailures: [],
		generatedAt: '2026-05-10T00:00:00.000Z',
		sourceHash: 'hash',
		tools: [
			{
				inputSchema: { properties: {}, type: 'object' },
				namespace: 'linear',
				toolName: 'search_issues',
			},
		],
	},
	graph: { relationships: [], skills: [] },
	identity: createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
	searchIndex: { search: () => ({ results: [] }) },
} satisfies PortalSession;

const portalAccessHeader = 'x-agent-vm-mcp-portal-secret';

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

describe('portal HTTP server', () => {
	it('GET /health returns registered agent ids', async () => {
		const app = createPortalHttpApp({
			registeredAgentIds: ['agent-b', 'agent-a'],
			toolRuntime: {
				callUpstreamTool: async () => ({}),
				getSession: async () => {
					throw new Error('not used');
				},
			},
		});

		const response = await app.request('/health');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ agents: ['agent-a', 'agent-b'], ok: true });
	});

	it('requires the portal access header before handling agent MCP requests', async () => {
		const app = createPortalHttpApp({
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
			serverAccess: { expectedValue: 'server-secret', headerName: portalAccessHeader },
			toolRuntime: {
				callUpstreamTool: async () => ({}),
				getSession: async () => {
					throw new Error('not used');
				},
			},
		});

		await expect(app.request('/agents/agent-a/mcp')).resolves.toMatchObject({
			status: 401,
		});
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { [portalAccessHeader]: 'server-secret' },
			}),
		).resolves.not.toMatchObject({ status: 401 });
	});

	it('serves initialize, tools/list, and tools/call through Streamable HTTP', async () => {
		const seenIdentities: PortalAgentIdentity[] = [];
		const closedIdentities: PortalAgentIdentity[] = [];
		const app = createPortalHttpApp({
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
			serverAccess: { expectedValue: 'server-secret', headerName: portalAccessHeader },
			onSessionClosed: (identity) => {
				closedIdentities.push(identity);
			},
			toolRuntime: {
				callUpstreamTool: async () => ({}),
				getSession: async (identity) => {
					seenIdentities.push(identity);
					return { ...session, identity };
				},
			},
		});
		const server = serve({ fetch: app.fetch, port: 0 });
		try {
			const address = server.address() as AddressInfo;
			const transport = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`),
				{ requestInit: { headers: { [portalAccessHeader]: 'server-secret' } } },
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
				ok: true,
				results: {
					'list-linear': {
						ok: true,
						output: {
							namespaces: ['linear'],
							tools: [expect.objectContaining({ namespace: 'linear', toolName: 'search_issues' })],
						},
					},
				},
			});
			expect(seenIdentities).toEqual([
				expect.objectContaining({
					agentId: 'agent-a',
					agentScopeId: 'agent-a',
					sessionId: expect.any(String),
				}),
			]);

			const invalidResult = await client.callTool({
				arguments: { requests: [] },
				name: 'mcp_portal_list',
			});
			expect(invalidResult.isError).toBe(true);

			await transport.terminateSession();
			await client.close();
			await vi.waitFor(() =>
				expect(closedIdentities).toEqual([
					expect.objectContaining({
						agentId: 'agent-a',
						agentScopeId: 'agent-a',
						sessionId: expect.any(String),
					}),
				]),
			);
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

	it('force-closes active sessions so reloaded runtimes make clients reconnect', async () => {
		const app = createPortalHttpApp({
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
			serverAccess: { expectedValue: 'server-secret', headerName: portalAccessHeader },
			toolRuntime: {
				callUpstreamTool: async () => ({}),
				getSession: async (identity) => ({ ...session, identity }),
			},
		});
		const server = serve({ fetch: app.fetch, port: 0 });
		try {
			const address = server.address() as AddressInfo;
			const transport = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`),
				{ requestInit: { headers: { [portalAccessHeader]: 'server-secret' } } },
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
						'mcp-session-id': sessionId,
						[portalAccessHeader]: 'server-secret',
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
});
