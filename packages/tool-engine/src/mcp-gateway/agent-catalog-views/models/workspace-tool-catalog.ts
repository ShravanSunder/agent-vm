import type { Tool } from '@modelcontextprotocol/server';

import type { PortalDiscoveryFailure } from '#mcp-gateway/agent-catalog-views/models/portal-discovery-failure';

export interface WorkspaceToolCatalogSnapshot {
	readonly kind: 'complete' | 'incomplete';
	readonly toolsByNamespace: ReadonlyMap<string, readonly Tool[]>;
	readonly discoveryFailures: readonly PortalDiscoveryFailure[];
}
export interface WorkspaceToolCatalog {
	readonly read: () => Promise<WorkspaceToolCatalogSnapshot>;
}
