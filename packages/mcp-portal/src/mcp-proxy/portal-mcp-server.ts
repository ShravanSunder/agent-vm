import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type {
	PortalAgentScope,
	PortalCore,
	PortalCoreEvent,
	PortalCoreToolDescriptor,
	PortalCoreResult,
	PortalCoreToolName,
	PreparedPortalCatalog,
} from '../core/portal-core.js';
import { portalToolInputSchemas } from '../core/portal-tools.js';
import { redactThrownError } from '../upstream-response-middleware.js';

export const portalMcpToolNames = [
	'mcp_portal_list',
	'mcp_portal_search',
	'mcp_portal_describe',
	'mcp_portal_call',
] as const;

export type PortalMcpToolName = (typeof portalMcpToolNames)[number];

const portalMcpToolNameSet = new Set<string>(portalMcpToolNames);
const standalonePortalApprovalMetaKey = 'agent-vm/tool-portal-approval-token';

export type PortalCatalogMode = 'catalog' | 'compact';

function isPortalCoreToolName(value: string): value is PortalCoreToolName {
	return portalMcpToolNameSet.has(value);
}

export function listPortalMcpTools(
	descriptors?: readonly PortalCoreToolDescriptor[],
): readonly Tool[] {
	return (
		descriptors ?? [
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
		]
	);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coreResultIsError(value: PortalCoreResult): boolean {
	if (value.items.some((item) => item.status === 'failed')) {
		return true;
	}
	if (!isObjectRecord(value.structuredContent)) {
		return false;
	}
	return value.structuredContent.ok === false;
}

function jsonToolResult(value: PortalCoreResult): CallToolResult {
	return {
		content: [{ text: JSON.stringify(value), type: 'text' }],
		...(coreResultIsError(value) ? { isError: true } : {}),
	};
}

function errorToolResult(error: unknown): CallToolResult {
	const redactedError = redactThrownError(error);
	return {
		content: [
			{
				text: redactedError.message,
				type: 'text',
			},
		],
		isError: true,
	};
}

async function sendBestEffortNotification(
	notification: {
		readonly method: 'notifications/message' | 'notifications/progress';
		readonly params: Record<string, unknown>;
	},
	sendNotification: (notification: {
		readonly method: 'notifications/message' | 'notifications/progress';
		readonly params: Record<string, unknown>;
	}) => Promise<void>,
): Promise<void> {
	try {
		await sendNotification(notification);
	} catch {
		// Progress is advisory; unsupported client notification channels must not fail the tool call.
	}
}

export async function emitMcpProgress(props: {
	readonly event: PortalCoreEvent;
	readonly sendNotification: (notification: {
		readonly method: 'notifications/message' | 'notifications/progress';
		readonly params: Record<string, unknown>;
	}) => Promise<void>;
	readonly progressToken: number | string | undefined;
}): Promise<void> {
	if (props.event.kind === 'upstream_notification') {
		if (!isObjectRecord(props.event.params)) {
			return;
		}
		if (props.event.method === 'notifications/progress') {
			if (props.progressToken === undefined) {
				return;
			}
			await sendBestEffortNotification(
				{
					method: 'notifications/progress',
					params: { ...props.event.params, progressToken: props.progressToken },
				},
				props.sendNotification,
			);
			return;
		}
		if (props.event.method !== 'notifications/message') {
			return;
		}
		await sendBestEffortNotification(
			{
				method: 'notifications/message',
				params: props.event.params,
			},
			props.sendNotification,
		);
		return;
	}
	if (props.event.kind !== 'progress' && props.event.kind !== 'partial_content') {
		return;
	}
	const message =
		props.event.kind === 'progress'
			? props.event.message
			: props.event.content.type === 'text'
				? props.event.content.text
				: JSON.stringify(props.event.content.value);
	if (message === undefined || message.length === 0) {
		return;
	}
	if (props.progressToken !== undefined) {
		await sendBestEffortNotification(
			{
				method: 'notifications/progress',
				params: {
					message,
					progress: props.event.kind === 'progress' ? (props.event.progress ?? 0) : 0,
					progressToken: props.progressToken,
					...(props.event.kind === 'progress' && props.event.total !== undefined
						? { total: props.event.total }
						: {}),
				},
			},
			props.sendNotification,
		);
		return;
	}
	await sendBestEffortNotification(
		{
			method: 'notifications/message',
			params: {
				data: message,
				level: 'info',
			},
		},
		props.sendNotification,
	);
}

export function createPortalMcpServer(props: {
	readonly catalog?: PreparedPortalCatalog;
	readonly catalogMode?: PortalCatalogMode;
	readonly core: PortalCore;
	readonly scope: PortalAgentScope;
}): Server {
	const catalogMode = props.catalogMode ?? 'compact';
	if (catalogMode === 'catalog' && props.catalog === undefined) {
		throw new Error('Catalog mode requires a complete prepared MCP Portal catalog.');
	}
	const catalogToolsByName = new Map(
		(props.catalog?.tools ?? []).map((tool) => [tool.descriptor.name, tool]),
	);
	const server = new Server(
		{ name: 'mcp-portal', version: '1.0.0' },
		{ capabilities: { tools: { listChanged: false } } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools:
			catalogMode === 'catalog'
				? (props.catalog?.tools.map((tool) => tool.descriptor) ?? [])
				: listPortalMcpTools(props.core.describeTools(props.scope)),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const catalogTool = catalogToolsByName.get(request.params.name);
		if (catalogMode === 'compact' && !isPortalCoreToolName(request.params.name)) {
			return {
				content: [{ text: `Unknown MCP Portal tool: ${request.params.name}`, type: 'text' }],
				isError: true,
			};
		}
		if (catalogMode === 'catalog' && catalogTool === undefined) {
			return {
				content: [
					{ text: `Unknown MCP Portal catalog tool: ${request.params.name}`, type: 'text' },
				],
				isError: true,
			};
		}
		try {
			const coreToolName: PortalCoreToolName =
				catalogTool === undefined && isPortalCoreToolName(request.params.name)
					? request.params.name
					: 'mcp_portal_call';
			const approvalToken = request.params['_meta']?.[standalonePortalApprovalMetaKey];
			const input =
				catalogTool === undefined
					? (request.params.arguments ?? {})
					: {
							calls: [
								{
									arguments: request.params.arguments ?? {},
									id: 'catalog-call',
									namespace: catalogTool.namespace,
									toolName: catalogTool.toolName,
								},
							],
							...(typeof approvalToken === 'string' ? { portalApprovalToken: approvalToken } : {}),
						};
			const result = await props.core.collectPortalCoreResult(
				props.core.callStream({
					input,
					scope: props.scope,
					signal: extra.signal,
					toolName: coreToolName,
				}),
				{
					onEvent: async (event) => {
						await emitMcpProgress({
							event,
							progressToken: extra['_meta']?.progressToken,
							sendNotification: extra.sendNotification,
						});
					},
				},
			);
			return jsonToolResult(result);
		} catch (error) {
			return errorToolResult(error);
		}
	});

	return server;
}
