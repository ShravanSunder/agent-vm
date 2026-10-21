import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import type {
	McpGateway,
	McpToolMode,
	PortalBatchResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';

function toolResult(result: PortalBatchResult): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(result) }],
		...(result.ok ? {} : { isError: true }),
	};
}
/** One fresh protocol server per HTTP request; gateway/cache lifetime belongs to the organization. */
export function createWorkerMcpServer(props: {
	readonly gateway: McpGateway;
	readonly mode: McpToolMode;
}): Server {
	const server = new Server(
		{ name: 'tool-host-cloudflare', version: '0.0.153' },
		{
			capabilities: { tools: {} },
		},
	);
	server.setRequestHandler('tools/list', async (request) => ({
		...(await props.gateway.listTools(props.mode, request.params?.cursor)),
	}));
	server.setRequestHandler('tools/call', async (request) => {
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
				if (props.mode === 'indirect')
					return { content: [{ type: 'text', text: 'Unknown or denied tool.' }], isError: true };
				return toolResult(
					await props.gateway.callDirect({
						name: request.params.name,
						arguments: jsonObjectSchema.parse(input),
						item: crypto.randomUUID(),
						catalog: await props.gateway.prepareCatalog(),
						...(request.params._meta === undefined
							? {}
							: { _meta: jsonObjectSchema.parse(request.params._meta) }),
					}),
				);
		}
	});
	return server;
}
