import type { ToolRelationship } from '#mcp-gateway/tool-search/models/tool-graph';
import type { ToolSummary } from '#mcp-gateway/tool-search/models/tool-summary';

export interface SearchQuery {
	readonly limit: number;
	readonly namespaces?: readonly string[];
	readonly query?: string;
}

export interface SearchResultSet {
	readonly results: readonly ToolSearchResult[];
}

export interface SearchIndex {
	readonly search: (query: SearchQuery) => SearchResultSet;
}

export interface SearchEntry {
	readonly inputFields: readonly string[];
	readonly relationshipHints: readonly ToolRelationshipHint[];
	readonly searchText: string;
	readonly summary: ToolSearchResult;
}

export interface ToolRelationshipHint {
	readonly field?: string;
	readonly reason: string;
	readonly sourceToolRef: string;
	readonly type: ToolRelationship['type'];
}

export interface ToolSearchResult extends ToolSummary {
	readonly relationshipHints?: readonly ToolRelationshipHint[];
	readonly schemaFieldMatches?: readonly string[];
}
