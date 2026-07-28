import {
	type PortalCallRequest,
	type PortalCallResult,
	PortalCallRequestSchema,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	PortalDescribeRequestSchema,
	type PortalListRequest,
	type PortalListResult,
	PortalListRequestSchema,
	type PortalSearchRequest,
	type PortalSearchResult,
	PortalSearchRequestSchema,
	createPortalCallSurfaceJsonSchemas,
} from '@agent-vm/agent-portal-sdk';
import type { ManagedAgentProjection } from '@agent-vm/agent-portal-sdk/contracts';
import type {
	GatewayRuntimeClientTrustedInvocationContext,
	GatewayRuntimePortalRequestOptions,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';

import type {
	OpenClawPluginToolContext,
	OpenClawToolRegistration,
	OpenClawToolRegistrationApi,
} from './openclaw-sandbox-sdk-contract.js';

export const TOOL_PORTAL_NATIVE_TOOL_NAMES = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;

type ToolPortalNativeToolName = (typeof TOOL_PORTAL_NATIVE_TOOL_NAMES)[number];

export interface OpenClawToolPortalClient {
	readonly portal: {
		readonly call: (
			request: PortalCallRequest,
			options: GatewayRuntimePortalRequestOptions,
		) => Promise<PortalCallResult>;
		readonly describe: (
			request: PortalDescribeRequest,
			options: GatewayRuntimePortalRequestOptions,
		) => Promise<PortalDescribeResult>;
		readonly list: (
			request: PortalListRequest,
			options: GatewayRuntimePortalRequestOptions,
		) => Promise<PortalListResult>;
		readonly search: (
			request: PortalSearchRequest,
			options: GatewayRuntimePortalRequestOptions,
		) => Promise<PortalSearchResult>;
	};
}

interface ToolPortalNativeToolRuntime {
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly clientProvider: () => OpenClawToolPortalClient | undefined;
}

export interface RegisterToolPortalNativeToolsProps {
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly api: OpenClawToolRegistrationApi;
	readonly clientProvider: () => OpenClawToolPortalClient | undefined;
	readonly logger?: {
		readonly warn?: (message: string) => void;
	};
}

function requireContextString(value: string | undefined, fieldName: string): string {
	if (value === undefined || value.length === 0) {
		throw new Error(`tool-portal: OpenClaw did not provide a trusted ${fieldName}.`);
	}
	return value;
}

function optionalContextString(value: string | undefined, fieldName: string): string | undefined {
	return value === undefined ? undefined : requireContextString(value, fieldName);
}

function trustedInvocationContext(options: {
	readonly context: OpenClawPluginToolContext;
	readonly runtime: ToolPortalNativeToolRuntime;
	readonly toolCallId: string;
}): GatewayRuntimeClientTrustedInvocationContext {
	const agentId = requireContextString(options.context.agentId, 'agentId');
	const projection = options.runtime.agentProjections[agentId];
	if (projection === undefined) {
		throw new Error(`tool-portal: OpenClaw agentId '${agentId}' is not configured.`);
	}
	if (
		projection.agentId !== agentId ||
		projection.frameworkIdentity.kind !== 'openclaw' ||
		projection.frameworkIdentity.agentId !== agentId
	) {
		throw new Error(
			`tool-portal: OpenClaw projection identity does not match authenticated agentId '${agentId}'.`,
		);
	}
	const authenticatedSubjectId = optionalContextString(
		options.context.requesterSenderId,
		'requesterSenderId',
	);
	const sessionId = optionalContextString(options.context.sessionId, 'sessionId');
	const sessionKey = optionalContextString(options.context.sessionKey, 'sessionKey');
	const toolCallId = requireContextString(options.toolCallId, 'toolCallId');
	return {
		correlation: {
			...(sessionId === undefined ? {} : { sessionId }),
			...(sessionKey === undefined ? {} : { sessionKey }),
			toolCallId,
		},
		principal: {
			agentId,
			frameworkIdentity: projection.frameworkIdentity,
			profileAssignmentRevision: projection.profileAssignmentRevision,
			toolPortalProfileId: projection.toolPortalProfileId,
		},
		...(authenticatedSubjectId === undefined ? {} : { requester: { authenticatedSubjectId } }),
	};
}

function toolPortalOperationOptions(options: {
	readonly signal: AbortSignal | undefined;
	readonly trustedContext: GatewayRuntimeClientTrustedInvocationContext;
}): GatewayRuntimePortalRequestOptions {
	return {
		...(options.signal === undefined ? {} : { signal: options.signal }),
		trustedContext: options.trustedContext,
	};
}

function createOpenClawToolResult(result: unknown): {
	readonly content: string;
	readonly details: unknown;
} {
	return {
		content: JSON.stringify(result),
		details: result,
	};
}

function createToolPortalNativeTool(props: {
	readonly context: OpenClawPluginToolContext;
	readonly inputSchema: Record<string, unknown>;
	readonly name: ToolPortalNativeToolName;
	readonly runtime: ToolPortalNativeToolRuntime;
}): OpenClawToolRegistration {
	return {
		description: descriptionForToolPortalTool(props.name),
		execute: async (toolCallId, params, signal) => {
			const trustedContext = trustedInvocationContext({
				context: props.context,
				runtime: props.runtime,
				toolCallId,
			});
			const client = props.runtime.clientProvider();
			if (client === undefined) {
				throw new Error('tool-portal: Gateway runtime client is unavailable during discovery.');
			}
			const options = toolPortalOperationOptions({ signal, trustedContext });
			if (props.name === 'tool_portal_list') {
				return createOpenClawToolResult(
					await client.portal.list(PortalListRequestSchema.parse(params), options),
				);
			}
			if (props.name === 'tool_portal_search') {
				return createOpenClawToolResult(
					await client.portal.search(PortalSearchRequestSchema.parse(params), options),
				);
			}
			if (props.name === 'tool_portal_describe') {
				return createOpenClawToolResult(
					await client.portal.describe(PortalDescribeRequestSchema.parse(params), options),
				);
			}
			return createOpenClawToolResult(
				await client.portal.call(PortalCallRequestSchema.parse(params), options),
			);
		},
		label: props.name,
		name: props.name,
		parameters: props.inputSchema,
	};
}

function descriptionForToolPortalTool(name: ToolPortalNativeToolName): string {
	if (name === 'tool_portal_list') {
		return 'List authorized Tool Portal capabilities and compact tool summaries.';
	}
	if (name === 'tool_portal_search') {
		return 'Search the caller-scoped Tool Portal capability index.';
	}
	if (name === 'tool_portal_describe') {
		return 'Describe exact Tool Portal capability schemas and helper details.';
	}
	return 'Validate and call an authorized Tool Portal capability by namespace and name.';
}

export function registerToolPortalNativeTools(props: RegisterToolPortalNativeToolsProps): void {
	const registerTool = props.api.registerTool;
	if (typeof registerTool !== 'function') {
		props.logger?.warn?.(
			'[tool-portal] skipped native tool registration; OpenClaw registerTool is absent.',
		);
		return;
	}
	const runtime: ToolPortalNativeToolRuntime = Object.freeze({
		agentProjections: Object.freeze(
			Object.fromEntries(
				Object.entries(props.agentProjections).map(([agentId, projection]) => [
					agentId,
					Object.freeze({
						...projection,
						frameworkIdentity: Object.freeze({ ...projection.frameworkIdentity }),
					}),
				]),
			),
		),
		clientProvider: props.clientProvider,
	});
	const schemas = createPortalCallSurfaceJsonSchemas();
	const schemasByName: Record<ToolPortalNativeToolName, Record<string, unknown>> = {
		tool_portal_call: schemas.call,
		tool_portal_describe: schemas.describe,
		tool_portal_list: schemas.list,
		tool_portal_search: schemas.search,
	};
	registerTool(
		(context) =>
			TOOL_PORTAL_NATIVE_TOOL_NAMES.map((name) =>
				createToolPortalNativeTool({
					context,
					inputSchema: schemasByName[name],
					name,
					runtime,
				}),
			),
		{
			names: TOOL_PORTAL_NATIVE_TOOL_NAMES,
			optional: true,
		},
	);
}
