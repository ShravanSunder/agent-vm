import { resolvePortalAccessPolicy } from '@agent-collaboration/tool-access/authorization';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, it, vi, expect } from 'vitest';

import { createAgentCatalogViewCache } from '#mcp-gateway/agent-catalog-views/agent-catalog-view-cache';
import { createPortalAgentIdentity } from '#mcp-gateway/agent-catalog-views/test-fixtures/agent-catalog-view-fixture';

describe('portal sessions', () => {
	it('defaults to deny all namespaces when no policy is configured', async () => {
		const listTools = vi.fn(
			async (): Promise<readonly Tool[]> => [
				{ inputSchema: { type: 'object' }, name: 'create_issue' },
			],
		);
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				defaultPolicy: 'deny-all',
				enabledNamespaces: [],
				enabledNamespacesByAgent: {},
				enabledToolsByNamespaceByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope: vi.fn(), listTools },
			upstreamNamespaces: ['linear'],
		});

		const session = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.tools).toEqual([]);
		expect(listTools).not.toHaveBeenCalled();
	});

	it('explicit allow-all exposes configured upstream namespaces', () => {
		const policy = resolvePortalAccessPolicy({
			config: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				enabledToolsByNamespaceByAgent: {},
				hiddenToolsByAgent: {},
			},
			identity: createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
			upstreamNamespaces: ['linear', 'github'],
		});

		expect(policy.allowedNamespaces).toEqual(['github', 'linear']);
	});

	it('treats an explicit empty global namespace list as deny all', () => {
		const policy = resolvePortalAccessPolicy({
			config: {
				defaultPolicy: 'allow-all',
				enabledNamespaces: [],
				enabledNamespacesByAgent: {},
				enabledToolsByNamespaceByAgent: {},
				hiddenToolsByAgent: {},
			},
			identity: createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
			upstreamNamespaces: ['linear', 'github'],
		});

		expect(policy.allowedNamespaces).toEqual([]);
	});

	it('removes non-enabled tools before catalog construction', async () => {
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				defaultPolicy: 'deny-all',
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				enabledToolsByNamespaceByAgent: {
					'agent-a': { linear: ['search_issues'] },
				},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: {
				closeAgentScope: vi.fn(),
				listTools: vi.fn(
					async (): Promise<readonly Tool[]> => [
						{ inputSchema: { type: 'object' }, name: 'create_issue' },
						{ inputSchema: { type: 'object' }, name: 'search_issues' },
					],
				),
			},
			upstreamNamespaces: ['linear'],
		});

		const session = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`)).toEqual([
			'linear.search_issues',
		]);
	});

	it('keeps exact tool policy scoped to its namespace', async () => {
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				defaultPolicy: 'deny-all',
				enabledNamespaces: ['deepwiki', 'linear'],
				enabledNamespacesByAgent: {},
				enabledToolsByNamespaceByAgent: {
					'agent-a': { deepwiki: ['ask_question'] },
				},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: {
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async ({ namespace }): Promise<readonly Tool[]> => {
					if (namespace === 'deepwiki') {
						return [
							{ inputSchema: { type: 'object' }, name: 'ask_question' },
							{ inputSchema: { type: 'object' }, name: 'read_wiki_contents' },
						];
					}
					return [
						{ inputSchema: { type: 'object' }, name: 'list_issues' },
						{ inputSchema: { type: 'object' }, name: 'save_issue' },
					];
				}),
			},
			upstreamNamespaces: ['deepwiki', 'linear'],
		});

		const session = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`)).toEqual([
			'deepwiki.ask_question',
			'linear.list_issues',
			'linear.save_issue',
		]);
	});

	it('builds separate scoped catalogs and search indexes per agent scope', async () => {
		const listTools = vi.fn(
			async ({ namespace }: { readonly namespace: string }): Promise<readonly Tool[]> => {
				if (namespace === 'linear') {
					return [{ inputSchema: { type: 'object' }, name: 'create_issue' }];
				}
				return [{ inputSchema: { type: 'object' }, name: 'search_highlights' }];
			},
		);
		const closeAgentScope = vi.fn();
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespacesByAgent: { 'agent-a': ['linear'], 'agent-b': ['readwise'] },
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope, listTools },
			upstreamNamespaces: ['linear', 'readwise'],
		});

		const agentA = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);
		const agentB = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-b', agentScopeId: 'agent-scope-b' }),
		);

		expect(agentA.catalog.tools.map((tool) => tool.namespace)).toEqual(['linear']);
		expect(agentB.catalog.tools.map((tool) => tool.namespace)).toEqual(['readwise']);
		expect(agentA.searchIndex.search({ query: 'highlight', limit: 10 }).results).toEqual([]);
	});

	it('removes hidden tools before catalog construction', async () => {
		const manager = createAgentCatalogViewCache({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: { 'agent-a': [{ namespace: 'linear', toolName: 'delete_issue' }] },
			},
			catalogTtlMs: 60_000,
			runtime: {
				closeAgentScope: vi.fn(),
				listTools: vi.fn(
					async (): Promise<readonly Tool[]> => [
						{ inputSchema: { type: 'object' }, name: 'create_issue' },
						{ inputSchema: { type: 'object' }, name: 'delete_issue' },
					],
				),
			},
			upstreamNamespaces: ['linear'],
		});

		const session = await manager.getView(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.tools.map((tool) => tool.toolName)).toEqual(['create_issue']);
	});
});
