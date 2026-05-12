import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';

import type { PortalBindingIdentity } from '../portal-access-policy.js';
import type { PortalSession } from '../portal-session.js';
import { createPortalHttpApp } from './portal-http-server.js';

const session = {
	catalog: {
		bindingId: 'binding-a',
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
	identity: { agentId: 'agent-a', bindingId: 'binding-a' },
	searchIndex: { search: () => ({ results: [] }) },
} satisfies PortalSession;

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
	it('requires the server-side binding secret before handling MCP requests', async () => {
		const app = createPortalHttpApp({
			getBinding: (bindingId) =>
				bindingId === 'binding-a'
					? { agentId: 'agent-a', bindingId: 'binding-a', secret: 'server-secret' }
					: null,
			toolRuntime: {
				callUpstreamTool: async () => ({}),
				getSession: async () => {
					throw new Error('not used');
				},
			},
		});

		await expect(app.request('/mcp-portal/bindings/binding-a/mcp')).resolves.toMatchObject({
			status: 401,
		});
		await expect(
			app.request('/mcp-portal/bindings/binding-a/mcp', {
				headers: { 'x-mcp-portal-binding-secret': 'server-secret' },
			}),
		).resolves.not.toMatchObject({ status: 401 });
	});

	it('serves initialize, tools/list, and tools/call through Streamable HTTP', async () => {
		const seenIdentities: PortalBindingIdentity[] = [];
		const closedIdentities: PortalBindingIdentity[] = [];
		const app = createPortalHttpApp({
			getBinding: (bindingId) =>
				bindingId === 'binding-a'
					? { agentId: 'agent-a', bindingId: 'binding-a', secret: 'server-secret' }
					: null,
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
				new URL(`http://127.0.0.1:${address.port}/mcp-portal/bindings/binding-a/mcp`),
				{ requestInit: { headers: { 'x-mcp-portal-binding-secret': 'server-secret' } } },
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
					bindingId: 'binding-a',
					sessionId: expect.any(String),
				}),
			]);

			await transport.terminateSession();
			await client.close();
			await vi.waitFor(() =>
				expect(closedIdentities).toEqual([
					expect.objectContaining({
						agentId: 'agent-a',
						bindingId: 'binding-a',
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
			getBinding: (bindingId) =>
				bindingId === 'binding-a'
					? { agentId: 'agent-a', bindingId: 'binding-a', secret: 'server-secret' }
					: null,
			toolRuntime: {
				callUpstreamTool: async () => ({}),
				getSession: async (identity) => ({ ...session, identity }),
			},
		});
		const server = serve({ fetch: app.fetch, port: 0 });
		try {
			const address = server.address() as AddressInfo;
			const transport = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${address.port}/mcp-portal/bindings/binding-a/mcp`),
				{ requestInit: { headers: { 'x-mcp-portal-binding-secret': 'server-secret' } } },
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
				app.request('/mcp-portal/bindings/binding-a/mcp', {
					headers: {
						'mcp-session-id': sessionId,
						'x-mcp-portal-binding-secret': 'server-secret',
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
