import type {
	PortalAgentIdentity,
	PortalAccessPolicyConfig,
} from '@agent-collaboration/tool-access/authorization';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { PortalToolRecord } from '#mcp-gateway/agent-catalog-views/models/catalog-types';
import type { SearchIndex } from '#mcp-gateway/tool-search/models/search-index';
import type { ToolGraph, SkillGraphInput } from '#mcp-gateway/tool-search/models/tool-graph';

export interface PortalCatalogSnapshot {
	readonly agentScopeId: string;
	readonly discoveryFailures: readonly PortalDiscoveryFailure[];
	readonly generatedAt: string;
	readonly sourceHash: string;
	readonly tools: readonly PortalToolRecord[];
}

export interface PortalDiscoveryFailure {
	readonly causeMessage?: string;
	readonly elapsedMs?: number;
	readonly hint?: string;
	readonly kind: string;
	readonly message: string;
	readonly namespace: string;
	readonly operation?: string;
	readonly phase?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport?: unknown;
}

export interface AgentCatalogView {
	readonly catalog: PortalCatalogSnapshot;
	readonly graph: ToolGraph;
	readonly identity: PortalAgentIdentity;
	readonly searchIndex: SearchIndex;
}

export interface AgentCatalogViewRuntime {
	readonly closeAgentScope: (agentScopeId: string) => Promise<void> | void;
	readonly closeSession?: (scopeKey: string) => Promise<void> | void;
	readonly listTools: (call: {
		readonly agentScopeId: string;
		readonly namespace: string;
	}) => Promise<readonly Tool[]>;
}

export interface AgentCatalogViewCacheOptions {
	readonly accessPolicy: PortalAccessPolicyConfig;
	readonly catalogTtlMs: number;
	readonly discoveryFailures?: readonly PortalDiscoveryFailure[];
	readonly now?: () => number;
	readonly runtime: AgentCatalogViewRuntime;
	readonly skills?: readonly SkillGraphInput[];
	readonly upstreamNamespaces: readonly string[];
}

export interface AgentCatalogViewCache {
	readonly getView: (identity: PortalAgentIdentity) => Promise<AgentCatalogView>;
	readonly invalidateAgentScope: (agentScopeId: string) => Promise<void>;
	readonly invalidateView: (identity: PortalAgentIdentity) => Promise<void>;
}

export interface PortalCatalogRefusal {
	readonly kind: 'upstream_discovery_failed' | 'catalog_tool_name_collision';
	readonly namespace: string;
}

export interface CachedPortalSession {
	readonly expiresAt: number;
	readonly session: AgentCatalogView;
}
