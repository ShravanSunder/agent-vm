import type { Tool } from '@modelcontextprotocol/server';

import type { PortalDiscoveryFailure } from '#mcp-gateway/agent-catalog-views/models/portal-discovery-failure';

export interface OrganizationToolCatalogSnapshot {
	readonly kind: 'complete' | 'incomplete';
	readonly toolsByNamespace: ReadonlyMap<string, readonly Tool[]>;
	readonly discoveryFailures: readonly PortalDiscoveryFailure[];
}
export interface OrganizationToolCatalog {
	readonly read: () => Promise<OrganizationToolCatalogSnapshot>;
}

export type NamespaceTools = ReadonlyMap<string, readonly Tool[]>;
export type DiscoveryFailures = ReadonlyMap<string, PortalDiscoveryFailure>;
export type CatalogState =
	| { readonly kind: 'unlisted' }
	| { readonly kind: 'complete'; readonly tools: NamespaceTools; readonly expiresAt: number }
	| {
			readonly kind: 'incomplete';
			readonly candidate: NamespaceTools;
			readonly failures: DiscoveryFailures;
	  }
	| {
			readonly kind: 'refresh-failed';
			readonly candidate: NamespaceTools;
			readonly failures: DiscoveryFailures;
			readonly complete: NamespaceTools;
	  };
