import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import {
	projectProxyMcpResult,
	type McpGateway,
	type McpToolMode,
	type PortalBatchResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';

import type { WorkerRequestLimits } from '#worker-host/worker-call-limits';
import {
	workerProtocolIdentity,
	projectWorkerLimitRefusals,
} from '#worker-host/worker-call-limits';

function toolResult(
	operation: Parameters<typeof projectProxyMcpResult>[0]['operation'],
	input: unknown,
	result: PortalBatchResult,
): CallToolResult {
	return projectProxyMcpResult({ operation, input, result: projectWorkerLimitRefusals(result) });
}
/** One fresh protocol server per HTTP request; gateway/cache lifetime belongs to the organization. */
export function createWorkerMcpServer(props: {
	readonly gateway: McpGateway;
	readonly mode: McpToolMode;
	readonly limits: WorkerRequestLimits;
	readonly recordCalls: (input: unknown, result: PortalBatchResult, startedAt: number) => void;
}): Server {
	const server = new Server(workerProtocolIdentity, {
		capabilities: { tools: {} },
	});
	server.setRequestHandler('tools/list', async (request) => ({
		...(await props.gateway.listTools(props.mode, request.params?.cursor)),
	}));
	server.setRequestHandler('tools/call', async (request, context) => {
		const input = request.params.arguments ?? {};
		const startedAt = Date.now();
		switch (request.params.name) {
			case 'mcp_portal_list':
				return toolResult('mcp_portal_list', input, await props.gateway.list(input));
			case 'mcp_portal_search':
				return toolResult('mcp_portal_search', input, await props.gateway.search(input));
			case 'mcp_portal_describe':
				return toolResult('mcp_portal_describe', input, await props.gateway.describe(input));
			case 'mcp_portal_call': {
				const refused = props.limits.begin(input, context.mcpReq.id);
				const result = refused ?? (await props.gateway.call(input));
				props.recordCalls(input, result, startedAt);
				return toolResult('mcp_portal_call', input, result);
			}
			default:
				if (props.mode === 'indirect')
					return { content: [{ type: 'text', text: 'Unknown or denied tool.' }], isError: true };
				const catalog = await props.gateway.prepareCatalog();
				const selected = catalog.tools.find((tool) => tool.descriptor.name === request.params.name);
				const normalized = {
					calls: [
						{
							id: 'catalog-call',
							namespace: selected?.namespace ?? 'unknown',
							toolName: selected?.toolName ?? 'unknown',
							arguments: input,
						},
					],
				};
				props.limits.begin(normalized, context.mcpReq.id);
				const result = await props.gateway.callDirect({
					name: request.params.name,
					arguments: jsonObjectSchema.parse(input),
					item: 'catalog-call',
					catalog,
					...(request.params['_meta'] === undefined
						? {}
						: { _meta: jsonObjectSchema.parse(request.params['_meta']) }),
				});
				props.recordCalls(normalized, result, startedAt);
				return toolResult('direct', input, result);
		}
	});
	return server;
}
