import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import {
	createPortalAgentIdentity as createPortalAgentIdentityBase,
	resolvePortalAccessPolicy,
	type PortalAgentIdentity,
} from './portal-access-policy.js';
import { createPortalSessionManager } from './portal-session.js';
import { UpstreamMcpError } from './upstream-mcp-errors.js';

function createPortalAgentIdentity(
	input: Omit<Parameters<typeof createPortalAgentIdentityBase>[0], 'source'>,
): PortalAgentIdentity {
	return createPortalAgentIdentityBase({ ...input, source: 'cli-operator' });
}

function createDeferred<TValue>(): {
	readonly promise: Promise<TValue>;
	readonly reject: (reason?: unknown) => void;
	readonly resolve: (value: TValue) => void;
} {
	let rejectPromise: ((reason?: unknown) => void) | undefined;
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	if (!rejectPromise || !resolvePromise) {
		throw new Error('deferred resolver was not initialized');
	}
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

describe('portal sessions', () => {
	it('defaults to deny all namespaces when no policy is configured', async () => {
		const listTools = vi.fn(
			async (): Promise<readonly Tool[]> => [
				{ inputSchema: { type: 'object' }, name: 'create_issue' },
			],
		);
		const manager = createPortalSessionManager({
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

		const session = await manager.getSession(
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
		const manager = createPortalSessionManager({
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

		const session = await manager.getSession(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.tools.map((tool) => `${tool.namespace}.${tool.toolName}`)).toEqual([
			'linear.search_issues',
		]);
	});

	it('keeps exact tool policy scoped to its namespace', async () => {
		const manager = createPortalSessionManager({
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

		const session = await manager.getSession(
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
		const manager = createPortalSessionManager({
			accessPolicy: {
				enabledNamespacesByAgent: { 'agent-a': ['linear'], 'agent-b': ['readwise'] },
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope, listTools },
			upstreamNamespaces: ['linear', 'readwise'],
		});

		const agentA = await manager.getSession(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);
		const agentB = await manager.getSession(
			createPortalAgentIdentity({ agentId: 'agent-b', agentScopeId: 'agent-scope-b' }),
		);

		expect(agentA.catalog.tools.map((tool) => tool.namespace)).toEqual(['linear']);
		expect(agentB.catalog.tools.map((tool) => tool.namespace)).toEqual(['readwise']);
		expect(agentA.searchIndex.search({ query: 'highlight', limit: 10 }).results).toEqual([]);
	});

	it('removes hidden tools before catalog construction', async () => {
		const manager = createPortalSessionManager({
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

		const session = await manager.getSession(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.tools.map((tool) => tool.toolName)).toEqual(['create_issue']);
	});

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
		const manager = createPortalSessionManager({
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

		const degradedSession = await manager.getSession(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-scope-a',
			}),
		);
		readwiseUnavailable = false;
		const recoveredSession = await manager.getSession(
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
		const manager = createPortalSessionManager({
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

		const sessionPromise = manager.getSession(
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
		const manager = createPortalSessionManager({
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

		const session = await manager.getSession(
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
		const manager = createPortalSessionManager({
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
						causeMessage: 'spawn ENOENT',
						elapsedMs: 12,
						hint: 'stdio MCP command failed before tool discovery; verify command, package bin name, gateway PATH, and arg count.',
						kind: 'upstream_mcp_failed',
						namespace: 'perplexity',
						operation: 'MCP stdio connect for namespace "perplexity"',
						phase: 'connect',
						timeoutMs: 30_000,
						transport: {
							argCount: 4,
							command: 'npx',
							kind: 'stdio',
						},
					});
				}),
			},
			upstreamNamespaces: ['perplexity'],
		});

		const session = await manager.getSession(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);

		expect(session.catalog.discoveryFailures).toEqual([
			{
				causeMessage: 'spawn ENOENT',
				elapsedMs: 12,
				hint: 'stdio MCP command failed before tool discovery; verify command, package bin name, gateway PATH, and arg count.',
				kind: 'upstream_mcp_failed',
				message: 'perplexity: connect failed: spawn ENOENT',
				namespace: 'perplexity',
				operation: 'MCP stdio connect for namespace "perplexity"',
				phase: 'connect',
				timeoutMs: 30_000,
				transport: {
					argCount: 4,
					command: 'npx',
					kind: 'stdio',
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
		const manager = createPortalSessionManager({
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

		const first = await manager.getSession(
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
		);
		now = 11;
		const second = await manager.getSession(
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
		const manager = createPortalSessionManager({
			accessPolicy: {
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			catalogTtlMs: 60_000,
			runtime: { closeAgentScope: vi.fn(), listTools },
			upstreamNamespaces: ['linear'],
		});

		await manager.getSession(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-scope-a',
				sessionId: 'session-a',
			}),
		);
		await manager.getSession(
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
		const manager = createPortalSessionManager({
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

		const firstSession = await manager.getSession(firstIdentity);
		const secondSession = await manager.getSession(secondIdentity);
		await manager.invalidateSession(firstIdentity);
		const rebuiltFirstSession = await manager.getSession(firstIdentity);
		const cachedSecondSession = await manager.getSession(secondIdentity);

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
		const manager = createPortalSessionManager({
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

		const staleSessionPromise = manager.getSession(identity);
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		await manager.invalidateAgentScope('agent-scope-a');
		firstListTools.resolve([{ inputSchema: { type: 'object' }, name: 'stale_tool' }]);
		await expect(staleSessionPromise).resolves.toMatchObject({
			catalog: { tools: [expect.objectContaining({ toolName: 'stale_tool' })] },
		});

		await expect(manager.getSession(identity)).resolves.toMatchObject({
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
		const manager = createPortalSessionManager({
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

		await manager.invalidateSession(identity);
		const staleSessionPromise = manager.getSession(identity);
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		await manager.invalidateAgentScope('agent-scope-a');
		firstListTools.resolve([{ inputSchema: { type: 'object' }, name: 'stale_tool' }]);
		await staleSessionPromise;
		await manager.getSession(identity);

		expect(closeSession).toHaveBeenCalledWith('agent-scope-a\nsession-a');
		expect(closeAgentScope).toHaveBeenCalledWith('agent-scope-a');
		expect(listTools).toHaveBeenCalledTimes(2);
	});
});
