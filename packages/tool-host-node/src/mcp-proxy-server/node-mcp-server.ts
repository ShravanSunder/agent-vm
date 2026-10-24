import { randomUUID } from 'node:crypto';

import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import {
	type McpGateway,
	type McpToolMode,
	projectProxyMcpResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';

function refusal(message: string): CallToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

export async function createNodeMcpServer(props: {
	readonly gateway: McpGateway;
	readonly mode: McpToolMode;
}): Promise<Server> {
	const server = new Server(
		{ name: 'tool-host-node', version: '0.0.153' },
		{
			capabilities: { tools: { listChanged: false } },
			cacheHints: {
				'server/discover': { cacheScope: 'private', ttlMs: 60_000 },
			},
		},
	);
	server.setRequestHandler('tools/list', async (request) => ({
		...(await props.gateway.listTools(props.mode, request.params?.cursor)),
	}));
	server.setRequestHandler('tools/call', async (request) => {
		try {
			const input = request.params.arguments ?? {};
			switch (request.params.name) {
				case 'mcp_portal_list':
					return projectProxyMcpResult({
						operation: 'mcp_portal_list',
						input,
						result: await props.gateway.list(input),
					});
				case 'mcp_portal_search':
					return projectProxyMcpResult({
						operation: 'mcp_portal_search',
						input,
						result: await props.gateway.search(input),
					});
				case 'mcp_portal_describe':
					return projectProxyMcpResult({
						operation: 'mcp_portal_describe',
						input,
						result: await props.gateway.describe(input),
					});
				case 'mcp_portal_call':
					return projectProxyMcpResult({
						operation: 'mcp_portal_call',
						input,
						result: await props.gateway.call(input),
					});
				default: {
					if (props.mode !== 'direct')
						return refusal(`Unknown MCP Portal tool: ${request.params.name}`);
					const catalog = await props.gateway.prepareCatalog();
					if (!catalog.tools.some((tool) => tool.descriptor.name === request.params.name))
						return refusal(`Unknown MCP Portal catalog tool: ${request.params.name}`);
					return projectProxyMcpResult({
						operation: 'direct',
						input,
						result: await props.gateway.callDirect({
							catalog,
							name: request.params.name,
							arguments: jsonObjectSchema.parse(input),
							item: randomUUID(),
							_meta: jsonObjectSchema.parse(request.params['_meta'] ?? {}),
						}),
					});
				}
			}
		} catch {
			return refusal('Tool request unavailable.');
		}
	});
	return server;
}
