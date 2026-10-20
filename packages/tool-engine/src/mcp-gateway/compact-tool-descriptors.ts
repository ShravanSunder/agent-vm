import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { portalToolInputSchemas } from '#mcp-gateway/portal-tool-contracts';
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function namespaceDescription(namespaces: readonly string[]): string {
	return namespaces.length === 0
		? 'No upstream MCP namespaces are authorized for this agent scope.'
		: `Allowed namespaces for this agent: ${namespaces.join(', ')}.`;
}

function cloneJsonObject<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

function withListNamespaceSchemaDescription(
	inputSchema: Tool['inputSchema'],
	namespaces: readonly string[],
): Tool['inputSchema'] {
	const clonedSchema = cloneJsonObject(inputSchema);
	const requests = isUnknownRecord(clonedSchema.properties)
		? clonedSchema.properties.requests
		: undefined;
	const requestItems = isUnknownRecord(requests) ? requests.items : undefined;
	const requestProperties = isUnknownRecord(requestItems) ? requestItems.properties : undefined;
	const namespaceProperty = isUnknownRecord(requestProperties)
		? requestProperties.namespaces
		: undefined;
	if (isUnknownRecord(namespaceProperty)) {
		namespaceProperty.description =
			namespaces.length === 0
				? 'Optional namespace filter. No upstream MCP namespaces are authorized for this agent. Omit to list all currently discovered authorized namespaces.'
				: `Optional namespace filter. Allowed namespaces for this agent: ${namespaces.join(', ')}. Omit to list all currently discovered authorized namespaces.`;
	}
	return clonedSchema;
}

export function listPortalCoreToolDescriptors(namespaces: readonly string[] = []): readonly Tool[] {
	const scopeDescription = namespaceDescription(namespaces);
	return [
		{
			description: `List authorized MCP namespaces and compact tool summaries. ${scopeDescription}`,
			inputSchema: withListNamespaceSchemaDescription(
				portalToolInputSchemas.mcp_portal_list,
				namespaces,
			),
			name: 'mcp_portal_list',
		},
		{
			description: 'Search the caller scoped MCP Portal index.',
			inputSchema: portalToolInputSchemas.mcp_portal_search,
			name: 'mcp_portal_search',
		},
		{
			description: 'Describe exact MCP tool schemas and optional TypeScript/Zod helpers.',
			inputSchema: portalToolInputSchemas.mcp_portal_describe,
			name: 'mcp_portal_describe',
		},
		{
			description: 'Validate and call an authorized upstream MCP tool by namespace and toolName.',
			inputSchema: portalToolInputSchemas.mcp_portal_call,
			name: 'mcp_portal_call',
		},
	];
}
