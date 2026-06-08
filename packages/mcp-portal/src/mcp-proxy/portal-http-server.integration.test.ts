import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';

import { createPortalCore, type PortalCore } from '../core/portal-core.js';
import {
	createPortalAgentIdentity as createPortalAgentIdentityBase,
	type PortalAgentIdentity,
} from '../portal-access-policy.js';
import { deriveAgentBearerToken } from '../portal-auth/agent-bearer-token.js';
import { createPortalHttpApp } from './portal-http-server.js';

const masterKey = Buffer.from('master-key');

interface TestRequestEnvironment {
	readonly incoming: {
		readonly socket: {
			readonly remoteAddress: string;
			readonly remoteFamily: string;
			readonly remotePort: number;
		};
	};
}

function createPortalAgentIdentity(
	input: Omit<Parameters<typeof createPortalAgentIdentityBase>[0], 'source'>,
): PortalAgentIdentity {
	return createPortalAgentIdentityBase({ ...input, source: 'mcp-proxy-bearer' });
}

function requestEnvironment(remoteAddress: string): TestRequestEnvironment {
	return {
		incoming: {
			socket: { remoteAddress, remoteFamily: 'IPv4', remotePort: 48123 },
		},
	};
}

function bearerAuthHeader(agentId: string, credentialVersion = 1): string {
	return `Bearer ${deriveAgentBearerToken({
		agentId,
		credentialVersion,
		masterKey,
	})}`;
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

function allowApproval(calls: readonly { readonly id: string }[]): {
	readonly decisionsByCallId: Readonly<Record<string, { readonly kind: 'allow' }>>;
} {
	return {
		decisionsByCallId: Object.fromEntries(calls.map((call) => [call.id, { kind: 'allow' }])),
	};
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
			enabledToolsByNamespaceByAgent: {},
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

	it('rejects bearers derived for stale credential versions at the HTTP boundary', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: {
				authorizationHeaderName: 'authorization',
				credentialVersionsByAgent: { 'agent-a': 2 },
				masterKey,
			},
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});

		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { authorization: bearerAuthHeader('agent-a', 1) },
			}),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { authorization: bearerAuthHeader('agent-a', 2) },
			}),
		).resolves.not.toMatchObject({ status: 401 });
	});

	it('returns opaque unauthorized responses for missing, invalid, and unknown-agent requests', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});
		const expectedUnauthorizedBody = { error: { kind: 'unauthorized' }, ok: false };

		const missingResponse = await app.request('/agents/agent-a/mcp');
		const badBearerResponse = await app.request('/agents/agent-a/mcp', {
			headers: { authorization: bearerAuthHeader('agent-b') },
		});
		const unknownAgentResponse = await app.request('/agents/missing-agent/mcp', {
			headers: { authorization: bearerAuthHeader('missing-agent') },
		});

		expect(missingResponse.status).toBe(401);
		expect(badBearerResponse.status).toBe(401);
		expect(unknownAgentResponse.status).toBe(401);
		await expect(missingResponse.json()).resolves.toEqual(expectedUnauthorizedBody);
		await expect(badBearerResponse.json()).resolves.toEqual(expectedUnauthorizedBody);
		await expect(unknownAgentResponse.json()).resolves.toEqual(expectedUnauthorizedBody);
	});

	it('audits bearer auth decisions without returning verifier details to clients', async () => {
		const auditEvents: unknown[] = [];
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			auditSink: (event) => {
				auditEvents.push(event);
			},
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});

		await app.request('/agents/missing-agent/mcp', {
			headers: { authorization: bearerAuthHeader('missing-agent') },
		});
		await app.request('/agents/agent-a/mcp', {
			headers: { authorization: bearerAuthHeader('agent-b') },
		});
		await app.request('/agents/agent-a/mcp', {
			headers: { authorization: bearerAuthHeader('agent-a') },
		});

		expect(auditEvents).toEqual([
			expect.objectContaining({
				agentId: 'missing-agent',
				decision: 'deny',
				kind: 'mcp_proxy_auth',
				reason: 'unknown_agent',
			}),
			expect.objectContaining({
				agentId: 'agent-a',
				decision: 'deny',
				kind: 'mcp_proxy_auth',
				reason: 'signature-mismatch',
			}),
			expect.objectContaining({
				agentId: 'agent-a',
				decision: 'allow',
				kind: 'mcp_proxy_auth',
			}),
		]);
	});

	it('reports audit sink failures without changing the auth response', async () => {
		const auditErrors: unknown[] = [];
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			auditErrorSink: (error) => {
				auditErrors.push(error);
			},
			auditSink: () => {
				throw new Error('audit sink unavailable');
			},
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});

		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { authorization: bearerAuthHeader('agent-a') },
			}),
		).resolves.not.toMatchObject({ status: 401 });
		expect(auditErrors).toEqual([expect.any(Error)]);
	});

	it('rate-limits repeated failed bearer attempts without trusting spoofed forwarded headers', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			authFailureLimit: { maxFailures: 2, windowMs: 60_000 },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});
		const badHeaders = {
			authorization: bearerAuthHeader('agent-b'),
			'x-forwarded-for': '203.0.113.4',
		};

		await expect(
			app.request('/agents/agent-a/mcp', { headers: badHeaders }),
		).resolves.toMatchObject({
			status: 401,
		});
		await expect(
			app.request('/agents/agent-a/mcp', { headers: badHeaders }),
		).resolves.toMatchObject({
			status: 401,
		});
		await expect(
			app.request('/agents/agent-a/mcp', { headers: badHeaders }),
		).resolves.toMatchObject({
			status: 429,
		});
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { ...badHeaders, 'x-forwarded-for': '203.0.113.5' },
			}),
		).resolves.toMatchObject({ status: 429 });
	});

	it('rate-limits failed bearer attempts across probed agent ids', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			authFailureLimit: { maxFailures: 2, windowMs: 60_000 },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});

		await expect(
			app.request('/agents/missing-a/mcp', {
				headers: { authorization: bearerAuthHeader('missing-a') },
			}),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			app.request('/agents/missing-b/mcp', {
				headers: { authorization: bearerAuthHeader('missing-b') },
			}),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			app.request('/agents/missing-c/mcp', {
				headers: { authorization: bearerAuthHeader('missing-c') },
			}),
		).resolves.toMatchObject({ status: 429 });
	});

	it('uses socket peer addresses when available for auth failure buckets', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			authFailureLimit: { maxFailures: 1, windowMs: 60_000 },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});
		await expect(
			app.request(
				'/agents/agent-a/mcp',
				{ headers: { authorization: bearerAuthHeader('agent-b') } },
				requestEnvironment('198.51.100.10'),
			),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			app.request(
				'/agents/agent-a/mcp',
				{ headers: { authorization: bearerAuthHeader('agent-b') } },
				requestEnvironment('198.51.100.10'),
			),
		).resolves.toMatchObject({ status: 429 });
		await expect(
			app.request(
				'/agents/agent-a/mcp',
				{ headers: { authorization: bearerAuthHeader('agent-b') } },
				requestEnvironment('198.51.100.11'),
			),
		).resolves.toMatchObject({ status: 401 });
	});

	it('resets auth failure buckets after the configured window', async () => {
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			authFailureLimit: { maxFailures: 1, windowMs: 5 },
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});

		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { authorization: bearerAuthHeader('agent-b') },
			}),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { authorization: bearerAuthHeader('agent-b') },
			}),
		).resolves.toMatchObject({ status: 429 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		await expect(
			app.request('/agents/agent-a/mcp', {
				headers: { authorization: bearerAuthHeader('agent-b') },
			}),
		).resolves.toMatchObject({ status: 401 });
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
			).resolves.toMatchObject({ status: 503 });

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

	it('rejects a new session request that started auth before shutdown began', async () => {
		let releaseAudit: (() => void) | undefined;
		const auditBlocked = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		let allowAuditStarted: (() => void) | undefined;
		const allowAuditSeen = new Promise<void>((resolve) => {
			allowAuditStarted = resolve;
		});
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			auditSink: async (event) => {
				if (event.decision === 'allow') {
					allowAuditStarted?.();
					await auditBlocked;
				}
			},
			core: createTestPortalCore(),
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a' })
					: null,
		});
		const requestPromise = app.request('/agents/agent-a/mcp', {
			headers: { authorization: bearerAuthHeader('agent-a') },
		});

		await allowAuditSeen;
		const closePromise = app.closePortalSessions();
		releaseAudit?.();

		await expect(requestPromise).resolves.toMatchObject({ status: 503 });
		await closePromise;
	});

	it('reports asynchronous session close hook failures from client disconnects', async () => {
		const sessionCloseErrors: Error[] = [];
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore(),
			onSessionCloseError: (error) => {
				sessionCloseErrors.push(error);
			},
			onSessionClosed: async () => {
				throw new Error('session close hook failed');
			},
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

			await fetch(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`, {
				headers: {
					authorization: bearerAuthHeader('agent-a'),
					'mcp-session-id': sessionId,
				},
				method: 'DELETE',
			});

			await vi.waitFor(() => {
				expect(sessionCloseErrors.map((error) => error.message)).toContain(
					'session close hook failed',
				);
			});
			await Promise.allSettled([client.close()]);
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
					return Promise.reject('first close failed');
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

			await expect(app.closePortalSessions()).rejects.toMatchObject({
				errors: [expect.any(Error)],
				message: 'Failed to close one or more MCP Portal sessions.',
			});
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

	it('rejects new MCP sessions after shutdown begins', async () => {
		let releaseClose: (() => void) | undefined;
		const closeStarted = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const app = createPortalHttpApp({
			agentBearerAuth: { authorizationHeaderName: 'authorization', masterKey },
			core: createTestPortalCore(),
			onSessionClosed: async () => {
				await closeStarted;
			},
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
			const closePromise = app.closePortalSessions();

			await expect(
				app.request('/agents/agent-a/mcp', {
					headers: { authorization: bearerAuthHeader('agent-a') },
				}),
			).resolves.toMatchObject({ status: 503 });

			releaseClose?.();
			await closePromise;
			await Promise.allSettled([client.close()]);
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
