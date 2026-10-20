import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import {
	type McpGateway,
	type PortalBatchResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { extractDirectOperationItem } from '#node-host/ingress/direct-operation-item';

function refusal(message: string): CallToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

function toolResult(result: PortalBatchResult): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(result) }],
		structuredContent: { ...result },
		...(result.ok ? {} : { isError: true }),
	};
}

export async function createNodeMcpServer(props: {
	readonly gateway: McpGateway;
	readonly exposure: 'catalog' | 'compact';
}): Promise<Server> {
	// Refuse full-catalog startup on incomplete discovery or duplicate exported names.
	const catalog = props.exposure === 'catalog' ? await props.gateway.prepareCatalog() : undefined;
	const server = new Server(
		{ name: 'tool-host-node', version: '0.0.153' },
		{ capabilities: { tools: { listChanged: false } } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: await props.gateway.listTools(props.exposure),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			if (catalog !== undefined) {
				const item = extractDirectOperationItem(request.params['_meta']);
				if (item === null)
					return refusal(
						'Supply a bounded operation item in _meta["tool-portal/operation-item"] or connect in compact exposure mode.',
					);
				const argumentsResult = jsonObjectSchema.safeParse(request.params.arguments ?? {});
				if (!argumentsResult.success) return refusal('Invalid tool arguments.');
				return toolResult(
					await props.gateway.callDirect({
						catalog,
						name: request.params.name,
						arguments: argumentsResult.data,
						item,
					}),
				);
			}
			const input = request.params.arguments ?? {};
			switch (request.params.name) {
				case 'mcp_portal_list':
					return toolResult(await props.gateway.list(input));
				case 'mcp_portal_search':
					return toolResult(await props.gateway.search(input));
				case 'mcp_portal_describe':
					return toolResult(await props.gateway.describe(input));
				case 'mcp_portal_call':
					return toolResult(await props.gateway.call(input));
				default:
					return refusal('Unknown or denied tool.');
			}
		} catch {
			return refusal('Tool request unavailable.');
		}
	});
	return server;
}
