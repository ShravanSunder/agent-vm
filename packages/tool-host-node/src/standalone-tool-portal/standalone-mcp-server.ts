import { randomUUID } from 'node:crypto';

import {
	createPortalCallSurfaceJsonSchemas,
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-collaboration/tool-access/contracts';
import { parsePortalArtifactReadResourceRequest } from '@agent-vm/agent-portal-sdk';
import {
	Server,
	ProtocolError,
	ProtocolErrorCode,
	PROTOCOL_VERSION_META_KEY,
	CLIENT_INFO_META_KEY,
	CLIENT_CAPABILITIES_META_KEY,
	type CallToolResult,
	type Tool,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { NodeHostAuthenticatedEnvelope } from '#node-host/mcp-proxy-server/models/bearer-credentials';
import type {
	StandaloneToolPortalArtifactReader,
	StandaloneToolPortalProjectionService,
} from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import { STANDALONE_TOOL_PORTAL_APPROVAL_META_KEY } from '#node-host/standalone-tool-portal/standalone-batch-approval';

export const STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;

function standaloneTools(): Tool[] {
	const schemas = createPortalCallSurfaceJsonSchemas();
	return STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES.map((name) => ({
		name,
		description: `Invoke the bounded standalone Tool Portal ${name.slice('tool_portal_'.length)} operation.`,
		inputSchema: {
			...(name === 'tool_portal_call'
				? schemas.call
				: name === 'tool_portal_describe'
					? schemas.describe
					: name === 'tool_portal_list'
						? schemas.list
						: schemas.search),
			type: 'object',
		},
	}));
}

export function projectStandaloneMcpResult(
	result: Awaited<
		ReturnType<StandaloneToolPortalProjectionService['call' | 'list' | 'search' | 'describe']>
	>,
): CallToolResult {
	const encoded = JSON.stringify(result);
	return {
		content: [
			{
				type: 'text',
				text:
					Buffer.byteLength(encoded, 'utf8') > 4096
						? 'Tool Portal result exceeded the MCP response bound.'
						: encoded,
			},
		],
		isError: result.items.some((item) => item.status === 'error'),
		structuredContent: result,
	};
}

export function createStandaloneToolPortalMcpServer(props: {
	readonly artifactReader: StandaloneToolPortalArtifactReader;
	readonly authenticatedEnvelope: NodeHostAuthenticatedEnvelope;
	readonly service: StandaloneToolPortalProjectionService;
}): Server {
	const server = new Server(
		{ name: 'agent-vm-standalone-tool-portal', version: '1.0.0' },
		{
			capabilities: {
				tools: { listChanged: false },
				resources: { listChanged: false, subscribe: false },
			},
			cacheHints: {
				'server/discover': { cacheScope: 'private', ttlMs: 60_000 },
				'tools/list': { cacheScope: 'private', ttlMs: 60_000 },
				'resources/read': { cacheScope: 'private', ttlMs: 0 },
			},
		},
	);
	server.setRequestHandler('tools/list', async () => ({ tools: standaloneTools() }));
	server.setRequestHandler('resources/read', async (request) => {
		try {
			const protocolFields = new Set<string>([
				PROTOCOL_VERSION_META_KEY,
				CLIENT_INFO_META_KEY,
				CLIENT_CAPABILITIES_META_KEY,
			]);
			// Only the negotiated protocol envelope is removed; unknown artifact metadata remains invalid.
			const publicRequest = parsePortalArtifactReadResourceRequest({
				...request.params,
				_meta: Object.fromEntries(
					Object.entries(request.params['_meta'] ?? {}).filter(([key]) => !protocolFields.has(key)),
				),
			});
			const result = await props.artifactReader.read({
				caller: { authenticatedEnvelope: props.authenticatedEnvelope, surfaceClass: 'mcp' },
				request: publicRequest,
			});
			return {
				contents: [
					{
						blob: result.contentBase64,
						...(result.mediaType === undefined ? {} : { mimeType: result.mediaType }),
						uri: request.params.uri,
					},
				],
			};
		} catch {
			throw new ProtocolError(
				ProtocolErrorCode.InvalidRequest,
				'Standalone Tool Portal artifact read failed.',
			);
		}
	});
	server.setRequestHandler('tools/call', async (request, context) => {
		try {
			const rawToken = request.params['_meta']?.[STANDALONE_TOOL_PORTAL_APPROVAL_META_KEY];
			const approvalToken =
				rawToken === undefined ? undefined : z.string().min(1).max(16_384).parse(rawToken);
			const options = {
				authenticatedEnvelope: props.authenticatedEnvelope,
				correlation: { sessionId: `standalone-mcp:${randomUUID()}` },
				signal: context.mcpReq.signal,
				surfaceClass: 'mcp' as const,
			};
			const input = request.params.arguments ?? {};
			const result =
				request.params.name === 'tool_portal_call'
					? await props.service.call(PortalCallRequestSchema.parse(input), {
							...options,
							...(approvalToken === undefined ? {} : { approvalToken }),
						})
					: request.params.name === 'tool_portal_list'
						? await props.service.list(PortalListRequestSchema.parse(input), options)
						: request.params.name === 'tool_portal_search'
							? await props.service.search(PortalSearchRequestSchema.parse(input), options)
							: request.params.name === 'tool_portal_describe'
								? await props.service.describe(PortalDescribeRequestSchema.parse(input), options)
								: null;
			return result === null
				? {
						content: [
							{ text: `Unknown standalone Tool Portal tool: ${request.params.name}`, type: 'text' },
						],
						isError: true,
					}
				: projectStandaloneMcpResult(result);
		} catch {
			return {
				content: [{ text: 'Standalone Tool Portal request failed.', type: 'text' }],
				isError: true,
			};
		}
	});
	return server;
}
