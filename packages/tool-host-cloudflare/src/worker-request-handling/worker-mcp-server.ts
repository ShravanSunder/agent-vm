import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import {
	type ProxyMcpOperation,
	type McpGateway,
	type McpToolMode,
	type PortalBatchResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';

import type { WorkerRequestLimits } from '#worker-host/worker-request-handling/worker-call-limits';
import {
	workerProtocolIdentity,
	projectBoundedWorkerToolResult,
} from '#worker-host/worker-request-handling/worker-call-limits';

function toolResult(
	operation: ProxyMcpOperation,
	input: unknown,
	result: PortalBatchResult,
	requestId: string | number,
	callHasStarted: WorkerRequestLimits['callHasStarted'],
): CallToolResult {
	return projectBoundedWorkerToolResult({ operation, input, result, requestId, callHasStarted })
		.response;
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
				return toolResult(
					'mcp_portal_list',
					input,
					await props.gateway.list(input),
					context.mcpReq.id,
					props.limits.callHasStarted,
				);
			case 'mcp_portal_search':
				return toolResult(
					'mcp_portal_search',
					input,
					await props.gateway.search(input),
					context.mcpReq.id,
					props.limits.callHasStarted,
				);
			case 'mcp_portal_describe':
				return toolResult(
					'mcp_portal_describe',
					input,
					await props.gateway.describe(input),
					context.mcpReq.id,
					props.limits.callHasStarted,
				);
			case 'mcp_portal_call': {
				const refused = props.limits.begin(input, context.mcpReq.id);
				const result = refused ?? (await props.gateway.call(input));
				const bounded = projectBoundedWorkerToolResult({
					operation: 'mcp_portal_call',
					input,
					result,
					requestId: context.mcpReq.id,
					callHasStarted: props.limits.callHasStarted,
				});
				// A batch-count refusal admits no calls and performs no per-call validation or analytics.
				if (refused === undefined) props.recordCalls(input, bounded.result, startedAt);
				return bounded.response;
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
				const bounded = projectBoundedWorkerToolResult({
					operation: 'direct',
					input,
					result,
					requestId: context.mcpReq.id,
					callHasStarted: props.limits.callHasStarted,
				});
				props.recordCalls(normalized, bounded.result, startedAt);
				return bounded.response;
		}
	});
	return server;
}
