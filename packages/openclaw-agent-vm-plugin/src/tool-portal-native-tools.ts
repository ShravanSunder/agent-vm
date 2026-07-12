import { createPortalCallSurfaceJsonSchemas } from '@agent-vm/agent-portal-sdk';
import {
	createManagedToolPortalInProcessRuntime,
	type ToolPortalInProcessEntryPoint,
} from '@agent-vm/tool-portal';

import {
	cacheKeyForGatewayControlCallerContext,
	type GatewayControlCallerContextCacheScope,
	type GatewayControlCallerContextStore,
} from './gateway-control-service/gateway-control-caller-context-store.js';
import { createGatewayControlControllerHostActionBackend } from './gateway-control-service/gateway-control-controller-host-action-backend.js';
import type {
	GatewayControlIdentity,
	GatewayControlService,
} from './gateway-control-service/gateway-control-service.js';
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

interface ToolPortalNativeToolRuntime {
	readonly getEntryPoint: (
		context: OpenClawPluginToolContext,
	) => Promise<ToolPortalInProcessEntryPoint>;
}

export interface RegisterToolPortalNativeToolsProps {
	readonly api: OpenClawToolRegistrationApi;
	readonly configDir: string;
	readonly gatewayControl?: {
		readonly callerContextStore: GatewayControlCallerContextStore;
		readonly identity: GatewayControlIdentity;
		readonly service: GatewayControlService;
	};
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

function callerContextScopeForOpenClawContext(options: {
	readonly context: OpenClawPluginToolContext;
	readonly zoneId: string;
}): GatewayControlCallerContextCacheScope {
	const agentId = requireContextString(options.context.agentId, 'agentId');
	const workspaceDir = requireContextString(
		options.context.workspaceDir ?? options.context.agentDir,
		'workspaceDir',
	);
	return {
		agentId,
		agentWorkspaceDir: options.context.agentDir ?? workspaceDir,
		purpose: 'tool_portal_controller_host_action',
		sessionKey: requireContextString(options.context.sessionKey, 'sessionKey'),
		workMountDir: workspaceDir,
		zoneId: options.zoneId,
	};
}

function createToolPortalNativeToolRuntime(props: {
	readonly configDir: string;
	readonly gatewayControl?: RegisterToolPortalNativeToolsProps['gatewayControl'];
}): ToolPortalNativeToolRuntime {
	const gatewayControl = props.gatewayControl;
	const callerContextScopeByEntryPointCacheKey = new Map<
		string,
		GatewayControlCallerContextCacheScope
	>();
	const managedRuntime = createManagedToolPortalInProcessRuntime({
		configDir: props.configDir,
		...(gatewayControl === undefined
			? {}
			: {
					createControllerHostActionBackend: (projection, context) => {
						const callerContextScope = callerContextScopeByEntryPointCacheKey.get(
							context.entryPointCacheKey,
						);
						if (callerContextScope === undefined) {
							throw new Error(
								'tool-portal: controller host action backend is missing caller context scope.',
							);
						}
						return createGatewayControlControllerHostActionBackend({
							callerContextStore: gatewayControl.callerContextStore,
							callerContextScope,
							controlService: gatewayControl.service,
							identity: gatewayControl.identity,
							projection,
						});
					},
				}),
	});

	return {
		getEntryPoint: async (context) => {
			if (context.agentId === undefined || context.agentId.length === 0) {
				throw new Error('tool-portal: OpenClaw did not provide a trusted agentId.');
			}
			if (gatewayControl !== undefined) {
				const callerContextScope = callerContextScopeForOpenClawContext({
					context,
					zoneId: gatewayControl.identity.zoneId,
				});
				const entryPointCacheKey = cacheKeyForGatewayControlCallerContext(callerContextScope);
				callerContextScopeByEntryPointCacheKey.set(entryPointCacheKey, callerContextScope);
				try {
					return await managedRuntime.getEntryPoint(context.agentId, { entryPointCacheKey });
				} finally {
					callerContextScopeByEntryPointCacheKey.delete(entryPointCacheKey);
				}
			}
			return await managedRuntime.getEntryPoint(context.agentId);
		},
	};
}

function toolPortalOperationOptions(signal: AbortSignal | undefined): {
	readonly signal?: AbortSignal;
} {
	return signal === undefined ? {} : { signal };
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
		execute: async (_toolCallId, params, signal) => {
			const entryPoint = await props.runtime.getEntryPoint(props.context);
			const options = toolPortalOperationOptions(signal);
			if (props.name === 'tool_portal_list') {
				return createOpenClawToolResult(await entryPoint.list(params, options));
			}
			if (props.name === 'tool_portal_search') {
				return createOpenClawToolResult(await entryPoint.search(params, options));
			}
			if (props.name === 'tool_portal_describe') {
				return createOpenClawToolResult(await entryPoint.describe(params, options));
			}
			return createOpenClawToolResult(await entryPoint.call(params, options));
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
	const runtime = createToolPortalNativeToolRuntime({
		configDir: props.configDir,
		...(props.gatewayControl === undefined ? {} : { gatewayControl: props.gatewayControl }),
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
