import {
	createPortalCallSurfaceJsonSchemas,
	parsePortalArtifactReadResourceRequest,
	PortalCallRequestSchema,
	type PortalCallRequest,
	PortalDescribeRequestSchema,
	type PortalDescribeRequest,
	PortalListRequestSchema,
	type PortalListRequest,
	PortalSearchRequestSchema,
	type PortalSearchRequest,
	type PortalArtifactReadRequest,
	type PortalArtifactReadResult,
	type PortalCallResult,
	type PortalDescribeResult,
	type PortalListResult,
	type PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
	type CallToolResult,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ToolPortalStandaloneServiceInvocationOptions } from '../tool-portal-invocation-contracts.js';
import type { ToolPortalService } from '../tool-portal-service.js';
import { STANDALONE_TOOL_PORTAL_APPROVAL_META_KEY } from './standalone-tool-portal-approval.js';
import type { StandaloneToolPortalAuthenticatedEnvelope } from './standalone-tool-portal-bearer-credentials.js';

export const STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;

const maximumMcpToolResultBytes = 4_096;

export interface StandaloneToolPortalArtifactReadCaller {
	readonly authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelope;
	readonly surfaceClass: 'mcp';
}

export interface StandaloneToolPortalInvocationOptions {
	readonly approvalToken?: string;
	readonly authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelope;
	readonly correlation: { readonly sessionId: string };
	readonly signal?: AbortSignal;
	readonly surfaceClass: 'http' | 'mcp';
}

export interface StandaloneToolPortalProjectionService {
	readonly call: (
		request: PortalCallRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalDescribeResult>;
	readonly list: (
		request: PortalListRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalSearchResult>;
}

function standaloneServiceOptions(
	options: StandaloneToolPortalInvocationOptions,
): ToolPortalStandaloneServiceInvocationOptions {
	return {
		...(options.approvalToken === undefined ? {} : { approvalToken: options.approvalToken }),
		correlation: options.correlation,
		origin: {
			authenticatedEnvelope: options.authenticatedEnvelope,
			kind: 'standalone',
		},
		...(options.signal === undefined ? {} : { signal: options.signal }),
		surfaceClass: options.surfaceClass,
	};
}

/** Adapt authenticated standalone transport metadata into the common service invocation union. */
export function createStandaloneToolPortalProjectionService(
	service: ToolPortalService<'standalone-v1'>,
): StandaloneToolPortalProjectionService {
	return {
		call: async (request, options) =>
			await service.capabilityCore.call(request, standaloneServiceOptions(options)),
		describe: async (request, options) =>
			await service.capabilityCore.describe(request, standaloneServiceOptions(options)),
		list: async (request, options) =>
			await service.capabilityCore.list(request, standaloneServiceOptions(options)),
		search: async (request, options) =>
			await service.capabilityCore.search(request, standaloneServiceOptions(options)),
	};
}

export interface StandaloneToolPortalArtifactReader {
	readonly read: (props: {
		readonly caller: StandaloneToolPortalArtifactReadCaller;
		readonly request: PortalArtifactReadRequest;
	}) => Promise<PortalArtifactReadResult>;
}

type ToolPortalProjectionResult =
	| PortalCallResult
	| PortalDescribeResult
	| PortalListResult
	| PortalSearchResult;

function inputSchemaForTool(
	toolName: (typeof STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES)[number],
): Tool['inputSchema'] {
	const schemas = createPortalCallSurfaceJsonSchemas();
	const schema =
		toolName === 'tool_portal_call'
			? schemas.call
			: toolName === 'tool_portal_describe'
				? schemas.describe
				: toolName === 'tool_portal_list'
					? schemas.list
					: schemas.search;
	return { ...schema, type: 'object' };
}

function standaloneMcpTools(): readonly Tool[] {
	return STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES.map((name) => ({
		description: `Invoke the bounded standalone Tool Portal ${name.slice('tool_portal_'.length)} operation.`,
		inputSchema: inputSchemaForTool(name),
		name,
	}));
}

function boundedMcpResult(result: ToolPortalProjectionResult): CallToolResult {
	const encoded = JSON.stringify(result);
	const text =
		Buffer.byteLength(encoded, 'utf8') > maximumMcpToolResultBytes
			? 'Tool Portal result exceeded the MCP response bound.'
			: encoded;
	return {
		content: [{ text, type: 'text' }],
		isError: result.items.some((item) => item.status === 'error'),
		structuredContent: result,
	};
}

export function createStandaloneToolPortalMcpServer(props: {
	readonly artifactReader: StandaloneToolPortalArtifactReader;
	readonly authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelope;
	readonly service: StandaloneToolPortalProjectionService;
	readonly sessionId: string;
}): McpServer {
	const server = new McpServer(
		{ name: 'agent-vm-standalone-tool-portal', version: '1.0.0' },
		{
			capabilities: {
				resources: { listChanged: false, subscribe: false },
				tools: { listChanged: false },
			},
		},
	);
	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		try {
			const publicRequest = parsePortalArtifactReadResourceRequest(request.params);
			const result = await props.artifactReader.read({
				caller: { authenticatedEnvelope: props.authenticatedEnvelope, surfaceClass: 'mcp' },
				request: publicRequest,
			});
			return {
				contents: [
					{
						blob: result.contentBase64,
						mimeType: result.mediaType,
						uri: request.params.uri,
					},
				],
			};
		} catch {
			throw new McpError(ErrorCode.InvalidRequest, 'Standalone Tool Portal artifact read failed.');
		}
	});
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: standaloneMcpTools() }));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const options = {
			authenticatedEnvelope: props.authenticatedEnvelope,
			correlation: { sessionId: props.sessionId },
			signal: extra.signal,
			surfaceClass: 'mcp',
		} as const;
		try {
			const publicArguments = request.params.arguments ?? {};
			const approvalToken = parseApprovalToken(request.params['_meta']);
			const callOptions = approvalToken === undefined ? options : { ...options, approvalToken };
			const invoke = async (): Promise<ToolPortalProjectionResult | null> =>
				request.params.name === 'tool_portal_call'
					? await props.service.call(PortalCallRequestSchema.parse(publicArguments), callOptions)
					: request.params.name === 'tool_portal_describe'
						? await props.service.describe(
								PortalDescribeRequestSchema.parse(publicArguments),
								options,
							)
						: request.params.name === 'tool_portal_list'
							? await props.service.list(PortalListRequestSchema.parse(publicArguments), options)
							: request.params.name === 'tool_portal_search'
								? await props.service.search(
										PortalSearchRequestSchema.parse(publicArguments),
										options,
									)
								: null;
			const result = await invoke();
			return result === null
				? {
						content: [
							{ text: `Unknown standalone Tool Portal tool: ${request.params.name}`, type: 'text' },
						],
						isError: true,
					}
				: boundedMcpResult(result);
		} catch {
			return {
				content: [{ text: 'Standalone Tool Portal request failed.', type: 'text' }],
				isError: true,
			};
		}
	});
	return server;
}

function parseApprovalToken(metadata: unknown): string | undefined {
	if (!isObjectRecord(metadata)) return undefined;
	const rawToken = metadata[STANDALONE_TOOL_PORTAL_APPROVAL_META_KEY];
	if (rawToken === undefined) return undefined;
	return z.string().min(1).max(16_384).parse(rawToken);
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createStandaloneToolPortalTransportBridge(
	transport: StreamableHTTPServerTransport,
): Transport {
	const bridge: Transport = {
		close: async () => await transport.close(),
		send: async (message, options) => await transport.send(message, options),
		start: async () => {
			// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
			if (bridge.onclose !== undefined) transport.onclose = bridge.onclose;
			// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
			if (bridge.onerror !== undefined) transport.onerror = bridge.onerror;
			// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
			if (bridge.onmessage !== undefined) transport.onmessage = bridge.onmessage;
			await transport.start();
		},
	};
	return bridge;
}
