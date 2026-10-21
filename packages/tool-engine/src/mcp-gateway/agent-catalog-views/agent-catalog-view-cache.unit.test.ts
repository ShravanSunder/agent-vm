import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, it, vi, expect } from 'vitest';

import { UpstreamMcpError } from '#connectors/upstream-mcp-errors';
import { createAgentCatalogViewCache } from '#mcp-gateway/agent-catalog-views/agent-catalog-view-cache';
import {
	createPortalAgentIdentity,
	createDeferred,
} from '#mcp-gateway/agent-catalog-views/test-fixtures/agent-catalog-view-fixture';

describe('portal sessions', () => {
	it('keeps healthy namespaces available but does not cache degraded discovery results', async () => {
		let readwiseUnavailable = true;
		const listTools = vi.fn(
			async ({ namespace }: { readonly namespace: string }): Promise<readonly Tool[]> => {
				if (namespace === 'readwise' && readwiseUnavailable) {
					throw new Error('readwise unavailable');
				}
				return [
					{
						inputSchema: { type: 'object' },
						name: namespace === 'readwise' ? 'search_highlights' : 'create_issue',
					},
				];
			},
		);
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear', 'readwise'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: {
				closeAgentScope: vi.fn(),
				listTools,
			},
			upstreamNamespaces: ['linear', 'readwise'],
		});

		const degradedSession = await manager.getView(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-scope-a',
			}),
		);
		readwiseUnavailable = false;
		const recoveredSession = await manager.getView(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-scope-a',
			}),
		);

		expect(degradedSession.catalog.discoveryFailures).toEqual([
			{
				kind: 'upstream_discovery_failed',
				message: 'readwise unavailable',
				namespace: 'readwise',
			},
		]);
		expect(
			degradedSession.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`),
		).toEqual(['linear.create_issue']);
		expect(
			recoveredSession.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`),
		).toEqual(['linear.create_issue', 'readwise.search_highlights']);
		expect(listTools).toHaveBeenCalledTimes(4);
	});

	it('retains an expired complete snapshot when refresh fails and reports the refresh failure', async () => {
		let nowMs = 1_000;
		let discoveryUnavailable = false;
		const listTools = vi.fn(async (): Promise<readonly Tool[]> => {
			if (discoveryUnavailable) {
				throw new Error('refresh unavailable');
			}
			return [{ inputSchema: { properties: {}, type: 'object' }, name: 'create_issue' }];
		});
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 10,
			now: () => nowMs,
			runtime: { closeAgentScope: vi.fn(), listTools },
			upstreamNamespaces: ['linear'],
		});
		const identity = createPortalAgentIdentity({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
		});
		const initial = await manager.getView(identity);
		discoveryUnavailable = true;
		nowMs += 11;

		const retained = await manager.getView(identity);

		expect(retained.catalog.sourceHash).toBe(initial.catalog.sourceHash);
		expect(retained.catalog.generatedAt).toBe(initial.catalog.generatedAt);
		expect(retained.catalog.tools.map((tool) => tool.toolName)).toEqual(['create_issue']);
		expect(retained.catalog.discoveryFailures).toEqual([
			{
				kind: 'upstream_discovery_failed',
				message: 'refresh unavailable',
				namespace: 'linear',
			},
		]);
		expect(listTools).toHaveBeenCalledTimes(2);
	});

	it('starts allowed namespace discovery concurrently and settles failed namespaces', async () => {
		const linearTools = createDeferred<readonly Tool[]>();
		const readwiseTools = createDeferred<readonly Tool[]>();
		const startedNamespaces: string[] = [];
		const listTools = vi.fn(
			async ({ namespace }: { readonly namespace: string }): Promise<readonly Tool[]> => {
				startedNamespaces.push(namespace);
				if (namespace === 'linear') {
					return await linearTools.promise;
				}
				if (namespace === 'readwise') {
					return await readwiseTools.promise;
				}
				throw new Error(`Unexpected namespace ${namespace}.`);
			},
		);
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear', 'readwise'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: {
				closeAgentScope: vi.fn(),
				listTools,
			},
			upstreamNamespaces: ['linear', 'readwise'],
		});

		const sessionPromise = manager.getView(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-scope-a',
			}),
		);
		await vi.waitFor(() => expect(startedNamespaces).toEqual(['linear', 'readwise']));
		linearTools.resolve([{ inputSchema: { type: 'object' }, name: 'create_issue' }]);
		readwiseTools.reject(new Error('readwise unavailable'));
		const degradedSession = await sessionPromise;

		expect(degradedSession.catalog.discoveryFailures).toEqual([
			{
				kind: 'upstream_discovery_failed',
				message: 'readwise unavailable',
				namespace: 'readwise',
			},
		]);
		expect(
			degradedSession.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`),
		).toEqual(['linear.create_issue']);
	});

	it('includes configured discovery diagnostics in the catalog snapshot', async () => {
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			discoveryFailures: [
				{
					kind: 'upstream_discovery_failed',
					message: 'MCP namespace "github" is missing url.',
					namespace: 'github',
				},
			],
			runtime: {
				closeAgentScope: vi.fn(),
				listTools: vi.fn(
					async (): Promise<readonly Tool[]> => [
						{ inputSchema: { type: 'object' }, name: 'create_issue' },
					],
				),
			},
			upstreamNamespaces: ['linear'],
		});

		const session = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.discoveryFailures).toEqual([
			{
				kind: 'upstream_discovery_failed',
				message: 'MCP namespace "github" is missing url.',
				namespace: 'github',
			},
		]);
		expect(session.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`)).toEqual([
			'linear.create_issue',
		]);
	});

	it('preserves structured upstream discovery diagnostics', async () => {
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['perplexity'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: {
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => {
					throw new UpstreamMcpError({
						causeMessage: 'connection refused',
						elapsedMs: 12,
						hint: 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.',
						kind: 'upstream_mcp_failed',
						namespace: 'perplexity',
						operation: 'MCP streamable-http connect for namespace "perplexity"',
						phase: 'connect',
						timeoutMs: 30_000,
						transport: {
							kind: 'streamable-http',
							url: 'https://example.test/',
						},
					});
				}),
			},
			upstreamNamespaces: ['perplexity'],
		});

		const session = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.discoveryFailures).toEqual([
			{
				causeMessage: 'connection refused',
				elapsedMs: 12,
				hint: 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.',
				kind: 'upstream_mcp_failed',
				message: 'perplexity: connect failed: connection refused',
				namespace: 'perplexity',
				operation: 'MCP streamable-http connect for namespace "perplexity"',
				phase: 'connect',
				timeoutMs: 30_000,
				transport: {
					kind: 'streamable-http',
					url: 'https://example.test/',
				},
			},
		]);
	});

	it('expires cached catalogs by TTL and closes only invalidated agent scopes', async () => {
		let now = 0;
		const closeAgentScope = vi.fn();
		const listTools = vi.fn(
			async (): Promise<readonly Tool[]> => [
				{ inputSchema: { type: 'object' }, name: `tool_${listTools.mock.calls.length}` },
			],
		);
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 10,
			now: () => now,
			runtime: { closeAgentScope, listTools },
			upstreamNamespaces: ['linear'],
		});

		const first = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);
		now = 11;
		const second = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);
		await manager.invalidateAgentScope('agent-scope-a');

		expect(first.catalog.sourceHash).not.toBe(second.catalog.sourceHash);
		expect(closeAgentScope).toHaveBeenCalledWith('agent-scope-a');
	});

	it('uses the transport session id as part of the upstream runtime scope', async () => {
		const listTools = vi.fn(
			async (): Promise<readonly Tool[]> => [
				{ inputSchema: { type: 'object' }, name: 'create_issue' },
			],
		);
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope: vi.fn(), listTools },
			upstreamNamespaces: ['linear'],
		});

		await manager.getView(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-scope-a',
				sessionId: 'session-a',
			}),
		);
		await manager.getView(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-scope-a',
				sessionId: 'session-b',
			}),
		);

		expect(listTools).toHaveBeenNthCalledWith(1, {
			agentScopeId: 'agent-scope-a\nsession-a',
			namespace: 'linear',
		});
		expect(listTools).toHaveBeenNthCalledWith(2, {
			agentScopeId: 'agent-scope-a\nsession-b',
			namespace: 'linear',
		});
	});

	it('invalidates one transport session without closing sibling sessions', async () => {
		const closeAgentScope = vi.fn();
		const closeSession = vi.fn();
		const listTools = vi.fn(
			async (): Promise<readonly Tool[]> => [
				{ inputSchema: { type: 'object' }, name: `tool_${listTools.mock.calls.length}` },
			],
		);
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope, closeSession, listTools },
			upstreamNamespaces: ['linear'],
		});
		const firstIdentity = createPortalAgentIdentity({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			sessionId: 'session-a',
		});
		const secondIdentity = createPortalAgentIdentity({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			sessionId: 'session-b',
		});

		const firstSession = await manager.getView(firstIdentity);
		const secondSession = await manager.getView(secondIdentity);
		await manager.invalidateView(firstIdentity);
		const rebuiltFirstSession = await manager.getView(firstIdentity);
		const cachedSecondSession = await manager.getView(secondIdentity);

		expect(closeSession).toHaveBeenCalledWith('agent-scope-a\nsession-a');
		expect(closeAgentScope).not.toHaveBeenCalled();
		expect(firstSession.catalog.sourceHash).not.toBe(rebuiltFirstSession.catalog.sourceHash);
		expect(cachedSecondSession.catalog.sourceHash).toBe(secondSession.catalog.sourceHash);
	});

	it('does not cache a session that finishes after agent scope invalidation', async () => {
		const firstListTools = createDeferred<readonly Tool[]>();
		const closeAgentScope = vi.fn();
		let listToolsCallCount = 0;
		const listTools = vi.fn(
			async (_call: {
				readonly agentScopeId: string;
				readonly namespace: string;
			}): Promise<readonly Tool[]> => {
				listToolsCallCount += 1;
				if (listToolsCallCount === 1) {
					return await firstListTools.promise;
				}
				return [{ inputSchema: { type: 'object' }, name: 'fresh_tool' } satisfies Tool];
			},
		);
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope, listTools },
			upstreamNamespaces: ['linear'],
		});
		const identity = createPortalAgentIdentity({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
		});

		const staleSessionPromise = manager.getView(identity);
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		await manager.invalidateAgentScope('agent-scope-a');
		firstListTools.resolve([{ inputSchema: { type: 'object' }, name: 'stale_tool' }]);
		await expect(staleSessionPromise).resolves.toMatchObject({
			catalog: { tools: [expect.objectContaining({ toolName: 'stale_tool' })] },
		});

		await expect(manager.getView(identity)).resolves.toMatchObject({
			catalog: { tools: [expect.objectContaining({ toolName: 'fresh_tool' })] },
		});
		expect(listTools).toHaveBeenCalledTimes(2);
		expect(closeAgentScope).toHaveBeenCalledWith('agent-scope-a');
	});

	it('does not cache a transport session when its parent scope is invalidated during build', async () => {
		const firstListTools = createDeferred<readonly Tool[]>();
		const closeAgentScope = vi.fn();
		const closeSession = vi.fn();
		let listToolsCallCount = 0;
		const listTools = vi.fn(async (): Promise<readonly Tool[]> => {
			listToolsCallCount += 1;
			if (listToolsCallCount === 1) {
				return await firstListTools.promise;
			}
			return [{ inputSchema: { type: 'object' }, name: 'fresh_tool' } satisfies Tool];
		});
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope, closeSession, listTools },
			upstreamNamespaces: ['linear'],
		});
		const identity = createPortalAgentIdentity({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			sessionId: 'session-a',
		});

		await manager.invalidateView(identity);
		const staleSessionPromise = manager.getView(identity);
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		await manager.invalidateAgentScope('agent-scope-a');
		firstListTools.resolve([{ inputSchema: { type: 'object' }, name: 'stale_tool' }]);
		await staleSessionPromise;
		await manager.getView(identity);

		expect(closeSession).toHaveBeenCalledWith('agent-scope-a\nsession-a');
		expect(closeAgentScope).toHaveBeenCalledWith('agent-scope-a');
		expect(listTools).toHaveBeenCalledTimes(2);
	});
});
