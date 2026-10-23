import {
	type PortalToolSelector,
	type PortalAgentIdentity,
	resolvePortalAccessPolicy,
	portalAgentScopeKey,
} from '@agent-collaboration/tool-access/authorization';
import type { Tool } from '@modelcontextprotocol/server';

import type {
	PortalCatalogRefusal,
	AgentCatalogViewCacheOptions,
	AgentCatalogViewCache,
	CachedPortalSession,
	AgentCatalogView,
} from '#mcp-gateway/agent-catalog-views/models/agent-catalog-view';
import {
	type PortalToolRecord,
	portalToolRecordSchema,
} from '#mcp-gateway/agent-catalog-views/models/catalog-types';
import type { PortalDiscoveryFailure } from '#mcp-gateway/agent-catalog-views/models/portal-discovery-failure';
import { createSearchIndex } from '#mcp-gateway/tool-search/search-index';
import { buildToolGraph } from '#mcp-gateway/tool-search/tool-graph';
import {
	upstreamMcpFailureDetailsFromUnknown,
	formatUpstreamMcpFailureMessage,
	messageFromUnknownError,
} from '#upstream-mcp-connectors/upstream-mcp-errors';

export class PortalCatalogPreparationError extends Error {
	readonly failedNamespaces: readonly string[];
	readonly refusals: readonly PortalCatalogRefusal[];

	constructor(failures: readonly PortalDiscoveryFailure[]) {
		const failedNamespaces = [...new Set(failures.map((failure) => failure.namespace))].toSorted();
		super(
			`MCP Portal catalog preparation failed for namespace(s): ${failedNamespaces.join(', ')}. Run live MCP validation or use indirect mode for partial discovery diagnostics.`,
		);
		this.name = 'PortalCatalogPreparationError';
		this.failedNamespaces = failedNamespaces;
		this.refusals = failures.map(
			(failure): PortalCatalogRefusal => ({
				kind:
					failure.kind === 'catalog_tool_name_collision'
						? 'catalog_tool_name_collision'
						: 'upstream_discovery_failed',
				namespace: failure.namespace,
			}),
		);
	}
}

function isHiddenTool(tool: PortalToolRecord, hiddenTools: readonly PortalToolSelector[]): boolean {
	return hiddenTools.some(
		(hiddenTool) =>
			hiddenTool.namespace === tool.namespace && hiddenTool.toolName === tool.toolName,
	);
}

function isEnabledTool(
	tool: PortalToolRecord,
	enabledToolsByNamespace: Readonly<Record<string, readonly string[]>>,
): boolean {
	const enabledTools = enabledToolsByNamespace[tool.namespace];
	if (enabledTools === undefined) {
		return true;
	}
	return enabledTools.includes(tool.toolName);
}

function portalToolFromMcpTool(namespace: string, tool: Tool): PortalToolRecord {
	return portalToolRecordSchema.parse({
		...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
		...(tool.description !== undefined ? { description: tool.description } : {}),
		inputSchema: tool.inputSchema,
		namespace,
		...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
		...(tool.title !== undefined ? { title: tool.title } : {}),
		toolName: tool.name,
	});
}

async function createSourceHash(tools: readonly PortalToolRecord[]): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify(tools)),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function discoveryFailureFromError(
	namespace: string,
	error: unknown,
): PortalDiscoveryFailure {
	const upstreamDetails = upstreamMcpFailureDetailsFromUnknown(error);
	if (upstreamDetails !== null) {
		return {
			...upstreamDetails,
			message: formatUpstreamMcpFailureMessage(upstreamDetails),
			namespace,
		};
	}
	return {
		kind: 'upstream_discovery_failed',
		message: messageFromUnknownError(error),
		namespace,
	};
}

export function createAgentCatalogViewCache(
	options: AgentCatalogViewCacheOptions,
): AgentCatalogViewCache {
	const sessions = new Map<string, CachedPortalSession>();
	const agentScopeGenerations = new Map<string, number>();
	const getNow = options.now ?? (() => Date.now());

	function generationForAgentScope(agentScopeId: string): number {
		return agentScopeGenerations.get(agentScopeId) ?? 0;
	}

	function incrementAgentScopeGeneration(agentScopeId: string): void {
		agentScopeGenerations.set(agentScopeId, generationForAgentScope(agentScopeId) + 1);
	}

	function generationForScope(scopeKey: string): number {
		const agentScopeId = scopeKey.split('\n', 1)[0] ?? scopeKey;
		return (agentScopeGenerations.get(scopeKey) ?? 0) + generationForAgentScope(agentScopeId);
	}

	function incrementScopeGeneration(scopeKey: string): void {
		agentScopeGenerations.set(scopeKey, generationForScope(scopeKey) + 1);
	}

	async function buildSession(identity: PortalAgentIdentity): Promise<AgentCatalogView> {
		const policy = resolvePortalAccessPolicy({
			config: options.accessPolicy,
			identity,
			upstreamNamespaces: options.upstreamNamespaces,
		});
		const tools: PortalToolRecord[] = [];
		const discoveryFailures: PortalDiscoveryFailure[] = [...(options.discoveryFailures ?? [])];
		const allowedNamespaces = policy.allowedNamespaces;

		const organization = await options.organizationCatalog?.read();
		if (organization !== undefined)
			discoveryFailures.push(
				...organization.discoveryFailures.filter((failure) =>
					allowedNamespaces.includes(failure.namespace),
				),
			);
		const namespaceToolGroups =
			organization === undefined
				? await Promise.allSettled(
						allowedNamespaces.map(async (namespace) => ({
							mcpTools: await options.runtime.listTools({
								agentScopeId: portalAgentScopeKey(identity),
								namespace,
							}),
							namespace,
						})),
					)
				: allowedNamespaces.map((namespace) => ({
						status: 'fulfilled' as const,
						value: { namespace, mcpTools: organization.toolsByNamespace.get(namespace) ?? [] },
					}));
		for (const [index, namespaceToolGroup] of namespaceToolGroups.entries()) {
			if (namespaceToolGroup.status === 'rejected') {
				const namespace = allowedNamespaces[index] ?? 'unknown';
				discoveryFailures.push(discoveryFailureFromError(namespace, namespaceToolGroup.reason));
				continue;
			}
			const { mcpTools, namespace } = namespaceToolGroup.value;
			for (const mcpTool of mcpTools) {
				const portalTool = portalToolFromMcpTool(namespace, mcpTool);
				if (
					isEnabledTool(portalTool, policy.enabledToolsByNamespace) &&
					!isHiddenTool(portalTool, policy.hiddenTools)
				) {
					tools.push(portalTool);
				}
			}
		}

		const sortedTools = tools.toSorted((left, right) => {
			const namespaceOrder = left.namespace.localeCompare(right.namespace);
			return namespaceOrder === 0 ? left.toolName.localeCompare(right.toolName) : namespaceOrder;
		});
		const graph = buildToolGraph({ skills: options.skills ?? [], tools: sortedTools });
		const catalog = {
			agentScopeId: identity.agentScopeId,
			...(organization === undefined ? {} : { organizationCatalogState: organization.kind }),
			discoveryFailures,
			generatedAt: new Date(getNow()).toISOString(),
			sourceHash: await createSourceHash(sortedTools),
			tools: sortedTools,
		};

		return {
			catalog,
			graph,
			identity,
			searchIndex: createSearchIndex(sortedTools, graph),
		};
	}

	return {
		async getView(identity: PortalAgentIdentity): Promise<AgentCatalogView> {
			if (options.organizationCatalog !== undefined) return buildSession(identity);
			const key = portalAgentScopeKey(identity);
			const now = getNow();
			const cached = sessions.get(key);
			if (cached && cached.expiresAt > now) {
				return cached.session;
			}

			const generation = generationForScope(key);
			const session = await buildSession(identity);
			if (cached !== undefined && session.catalog.discoveryFailures.length > 0) {
				return {
					...cached.session,
					catalog: {
						...cached.session.catalog,
						discoveryFailures: session.catalog.discoveryFailures,
					},
				};
			}
			if (
				generationForScope(key) === generation &&
				session.catalog.discoveryFailures.length === 0
			) {
				sessions.set(key, { expiresAt: now + options.catalogTtlMs, session });
			}
			return session;
		},
		async invalidateAgentScope(agentScopeId: string): Promise<void> {
			incrementAgentScopeGeneration(agentScopeId);
			for (const key of sessions.keys()) {
				if (key === agentScopeId || key.startsWith(`${agentScopeId}\n`)) {
					sessions.delete(key);
				}
			}
			await options.runtime.closeAgentScope(agentScopeId);
		},
		async invalidateView(identity: PortalAgentIdentity): Promise<void> {
			const scopeKey = portalAgentScopeKey(identity);
			incrementScopeGeneration(scopeKey);
			sessions.delete(scopeKey);
			if (options.runtime.closeSession) {
				await options.runtime.closeSession(scopeKey);
				return;
			}
			await options.runtime.closeAgentScope(scopeKey);
		},
	};
}
