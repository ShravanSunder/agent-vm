import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { PortalAgentIdentity } from '../portal-access-policy.js';
import {
	createPortalToolHandlers,
	portalToolInputSchemas,
	type PortalToolRuntime,
} from './portal-tools.js';

export const portalMcpToolNames = [
	'mcp_portal_list',
	'mcp_portal_search',
	'mcp_portal_describe',
	'mcp_portal_call',
] as const;

export type PortalMcpToolName = (typeof portalMcpToolNames)[number];

export function listPortalMcpTools(): readonly Tool[] {
	return [
		{
			description: 'List authorized MCP namespaces and compact tool summaries.',
			inputSchema: portalToolInputSchemas.mcp_portal_list,
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

function jsonToolResult(value: unknown): CallToolResult {
	return {
		content: [{ text: JSON.stringify(value), type: 'text' }],
	};
}

export function createPortalMcpServer(props: {
	readonly identity: PortalAgentIdentity;
	readonly runtime: PortalToolRuntime;
}): Server {
	const handlers = createPortalToolHandlers(props.runtime);
	const server = new Server(
		{ name: 'mcp-portal', version: '1.0.0' },
		{ capabilities: { tools: { listChanged: false } } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: listPortalMcpTools(),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		switch (request.params.name) {
			case 'mcp_portal_list':
				return jsonToolResult(
					await handlers.list({ identity: props.identity, input: request.params.arguments ?? {} }),
				);
			case 'mcp_portal_search':
				return jsonToolResult(
					await handlers.search({
						identity: props.identity,
						input: request.params.arguments ?? {},
					}),
				);
			case 'mcp_portal_describe':
				return jsonToolResult(
					await handlers.describe({
						identity: props.identity,
						input: request.params.arguments ?? {},
					}),
				);
			case 'mcp_portal_call':
				return jsonToolResult(
					await handlers.call({ identity: props.identity, input: request.params.arguments ?? {} }),
				);
			default:
				return {
					content: [{ text: `Unknown MCP Portal tool: ${request.params.name}`, type: 'text' }],
					isError: true,
				};
		}
	});

	return server;
}
