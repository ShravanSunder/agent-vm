import {
	loadMcpConfig,
	loadMcpPortalConfig,
	type McpPortalConfig,
	resolveMcpPortalProfile,
	type ResolvedMcpPortalProfile,
	type SecretValue,
} from '@agent-vm/config-contracts';
import {
	createPortalCore,
	createPortalPolicyApprovalEvaluator,
	createUpstreamMcpClientRuntime,
	listPortalCoreToolDescriptors,
	resolveUpstreamServers,
	type PortalCore,
	type PortalCoreEvent,
	type PortalCoreToolDescriptor,
	type PortalToolSelector,
} from '@agent-vm/mcp-portal/core';

import { createBeforePromptBuildHandler } from './before-prompt-build-handler.js';
import { createBeforeToolCallHandler } from './before-tool-call-handler.js';
import { resolveEffectiveConfigPaths } from './effective-config-manifest.js';
import type {
	OpenClawPortalPluginApi,
	OpenClawPluginToolContext,
	OpenClawToolRegistration,
	OpenClawToolUpdateCallback,
} from './openclaw-plugin-api.js';
import { parsePortalConfig } from './portal-config.js';
import { createPortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

interface PortalPluginEntry {
	readonly description: string;
	readonly id: string;
	readonly name: string;
	readonly register: (api: OpenClawPortalPluginApi) => void;
}

interface TcpPoolConfig {
	readonly basePort: number;
	readonly size: number;
}

interface ProfilePolicyMaps {
	readonly cacheTtlMs: number;
	readonly enabledNamespacesByAgent: Readonly<Record<string, readonly string[]>>;
	readonly enabledToolsByNamespaceByAgent: Readonly<
		Record<string, Readonly<Record<string, readonly string[]>>>
	>;
	readonly hiddenToolsByAgent: Readonly<Record<string, readonly PortalToolSelector[]>>;
}

const pluginId = 'mcp-portal';

function hasFunction(value: unknown): value is (...args: readonly unknown[]) => unknown {
	return typeof value === 'function';
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value);
}

function getObjectProperty(value: unknown, property: string): unknown {
	return isObjectRecord(value) ? value[property] : undefined;
}

function resolveConfigDir(api: OpenClawPortalPluginApi): string {
	if (api.pluginConfig !== undefined) {
		return parsePortalConfig(api.pluginConfig).configDir;
	}
	// Managed agent-vm passes pluginConfig. The config fallbacks keep the plugin usable
	// in direct OpenClaw test harnesses that load plugin config through the root config.
	const topLevelMcpConfigDir = getObjectProperty(
		getObjectProperty(api.config, 'mcpPortal'),
		'configDir',
	);
	if (typeof topLevelMcpConfigDir === 'string' && topLevelMcpConfigDir.length > 0) {
		return topLevelMcpConfigDir;
	}
	const zones = getObjectProperty(api.config, 'zones');
	if (isUnknownArray(zones)) {
		const firstZone = zones.at(0);
		const zoneMcpConfigDir = getObjectProperty(
			getObjectProperty(firstZone, 'mcpPortal'),
			'configDir',
		);
		if (typeof zoneMcpConfigDir === 'string' && zoneMcpConfigDir.length > 0) {
			return zoneMcpConfigDir;
		}
	}
	throw new Error(
		'MCP Portal plugin requires configDir in plugin config or zone mcpPortal config.',
	);
}

export function validatePortalPortAgainstTcpPool(props: {
	readonly port: number;
	readonly tcpPool: TcpPoolConfig | null;
}): void {
	if (props.tcpPool === null) {
		return;
	}
	const firstTcpPoolPort = props.tcpPool.basePort;
	const lastTcpPoolPortExclusive = props.tcpPool.basePort + props.tcpPool.size;
	if (props.port >= firstTcpPoolPort && props.port < lastTcpPoolPortExclusive) {
		throw new Error(
			`MCP Portal port ${String(props.port)} overlaps the Tool VM TCP pool ` +
				`[${String(firstTcpPoolPort)}, ${String(lastTcpPoolPortExclusive)}).`,
		);
	}
}

function createLoggerAdapter(api: OpenClawPortalPluginApi): {
	readonly error: (message: string) => void;
	readonly info: (message: string) => void;
	readonly warn: (message: string) => void;
} {
	return {
		error: (message) => api.logger?.error?.(message),
		info: (message) => api.logger?.info?.(message),
		warn: (message) => api.logger?.warn?.(message),
	};
}

export function validatePortalPluginApi(api: OpenClawPortalPluginApi): void {
	if (!hasFunction(api.registerTool)) {
		throw new Error('MCP Portal plugin requires OpenClaw registerTool API.');
	}
	if (!hasFunction(api.on)) {
		throw new Error('MCP Portal plugin requires OpenClaw before_tool_call hook API.');
	}
	const hasLifecycleCleanupApi =
		hasFunction(api.lifecycle?.registerRuntimeLifecycle) ||
		hasFunction(api.registerRuntimeLifecycle);
	if (hasLifecycleCleanupApi) {
		return;
	}
	throw new Error('MCP Portal plugin requires an OpenClaw lifecycle cleanup API.');
}

function registerPortalRuntimeCleanup(
	api: OpenClawPortalPluginApi,
	cleanup: () => Promise<void> | void,
): void {
	const runtimeLifecycle = {
		cleanup: async () => {
			await cleanup();
		},
		description: 'Closes MCP Portal upstream clients owned by the agent-vm plugin.',
		id: 'mcp-portal-core',
	} satisfies Parameters<NonNullable<OpenClawPortalPluginApi['registerRuntimeLifecycle']>>[0];
	if (hasFunction(api.lifecycle?.registerRuntimeLifecycle)) {
		api.lifecycle.registerRuntimeLifecycle(runtimeLifecycle);
		return;
	}
	if (hasFunction(api.registerRuntimeLifecycle)) {
		api.registerRuntimeLifecycle(runtimeLifecycle);
		return;
	}
	throw new Error('MCP Portal plugin requires an OpenClaw lifecycle cleanup API.');
}

function selectorsFromNamespaceTools(
	namespaceTools: Readonly<Record<string, readonly string[]>>,
): readonly PortalToolSelector[] {
	return Object.entries(namespaceTools).flatMap(([namespace, toolNames]) =>
		toolNames.map((toolName) => ({ namespace, toolName })),
	);
}

function buildProfilePolicyMaps(portalConfig: McpPortalConfig): ProfilePolicyMaps {
	const enabledNamespacesByAgent: Record<string, readonly string[]> = {};
	const enabledToolsByNamespaceByAgent: Record<
		string,
		Readonly<Record<string, readonly string[]>>
	> = {};
	const hiddenToolsByAgent: Record<string, readonly PortalToolSelector[]> = {};
	const profileTtls: number[] = [];

	for (const [agentId, agent] of Object.entries(portalConfig.agents)) {
		const profile: ResolvedMcpPortalProfile = resolveMcpPortalProfile(portalConfig, agent.profile);
		enabledNamespacesByAgent[agentId] = profile.enabledNamespaces;
		enabledToolsByNamespaceByAgent[agentId] = profile.enabledToolsByNamespace;
		hiddenToolsByAgent[agentId] = selectorsFromNamespaceTools(profile.hiddenToolsByNamespace);
		profileTtls.push(profile.cache.catalogTtlMs);
	}

	return {
		cacheTtlMs: profileTtls.length === 0 ? 60_000 : Math.min(...profileTtls),
		enabledNamespacesByAgent,
		enabledToolsByNamespaceByAgent,
		hiddenToolsByAgent,
	};
}

async function resolveManagedPortalSecret(secret: SecretValue): Promise<string> {
	if (secret.source !== 'environment') {
		throw new Error(
			'MCP Portal managed OpenClaw effective config must use environment secret refs.',
		);
	}
	const value = process.env[secret.name];
	if (value === undefined || value.length === 0) {
		throw new Error(`Missing environment secret ${secret.name} for MCP Portal native plugin.`);
	}
	return value;
}

async function createManagedPortalCore(
	configDir: string,
	runtimeState: ReturnType<typeof createPortalPluginRuntimeState>,
): Promise<PortalCore> {
	const effectiveConfigPaths = await resolveEffectiveConfigPaths(configDir);
	const [mcpConfig, portalConfig] = await Promise.all([
		loadMcpConfig(effectiveConfigPaths.mcpConfigPath),
		loadMcpPortalConfig(effectiveConfigPaths.portalConfigPath),
	]);
	const upstreamServers = await resolveUpstreamServers({
		config: mcpConfig,
		resolveSecret: resolveManagedPortalSecret,
	});
	const upstreamRuntime = createUpstreamMcpClientRuntime({ servers: upstreamServers });
	const profilePolicyMaps = buildProfilePolicyMaps(portalConfig);
	const approval = createPortalPolicyApprovalEvaluator({
		consumeTokenId: (agentId, jti, expiresAtMs) =>
			runtimeState.consumeApprovalTokenId(agentId, jti, expiresAtMs),
		missingApprovalTokenDecision: { kind: 'approval_required', level: 'standard' },
		resolveRecord: (agentId) => {
			const agent = portalConfig.agents[agentId];
			if (agent === undefined) {
				return undefined;
			}
			return {
				hmacKey: runtimeState.getApprovalHmacKey(),
				profile: resolveMcpPortalProfile(portalConfig, agent.profile),
			};
		},
	});

	return createPortalCore({
		accessPolicy: {
			defaultPolicy: 'deny-all',
			enabledNamespacesByAgent: profilePolicyMaps.enabledNamespacesByAgent,
			enabledToolsByNamespaceByAgent: profilePolicyMaps.enabledToolsByNamespaceByAgent,
			hiddenToolsByAgent: profilePolicyMaps.hiddenToolsByAgent,
		},
		approval,
		catalogTtlMs: profilePolicyMaps.cacheTtlMs,
		runtime: {
			callUpstreamTool: upstreamRuntime.callTool,
			closeAgentScope: upstreamRuntime.closeAgentScope,
			closeSession: upstreamRuntime.closeSession,
			listTools: upstreamRuntime.listTools,
		},
		upstreamNamespaces: upstreamServers.map((server) => server.namespace),
	});
}

function portalUpdateFromCoreEvent(event: PortalCoreEvent): Record<string, unknown> | null {
	if (event.kind === 'progress') {
		return {
			message: event.message ?? 'MCP Portal progress',
			...(event.progress !== undefined ? { progress: event.progress } : {}),
			requestId: event.requestId,
			...(event.total !== undefined ? { total: event.total } : {}),
			type: 'mcp_portal_progress',
		};
	}
	if (event.kind === 'partial_content') {
		return {
			content: event.content,
			requestId: event.requestId,
			type: 'mcp_portal_partial_content',
		};
	}
	if (event.kind === 'upstream_notification') {
		return {
			method: event.method,
			params: event.params,
			requestId: event.requestId,
			type: 'mcp_portal_upstream_notification',
		};
	}
	return null;
}

async function forwardCoreEvent(
	event: PortalCoreEvent,
	logger: ReturnType<typeof createLoggerAdapter>,
	onUpdate: OpenClawToolUpdateCallback | undefined,
): Promise<void> {
	const update = portalUpdateFromCoreEvent(event);
	if (update !== null) {
		try {
			await onUpdate?.(update);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`[mcp-portal] OpenClaw onUpdate delivery failed: ${message}`);
		}
	}
}

function createNativeTool(props: {
	readonly context: OpenClawPluginToolContext;
	readonly descriptor: PortalCoreToolDescriptor;
	readonly getCore: () => Promise<PortalCore>;
	readonly logger: ReturnType<typeof createLoggerAdapter>;
}): OpenClawToolRegistration {
	return {
		description: props.descriptor.description,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			if (props.context.agentId === undefined || props.context.agentId.length === 0) {
				throw new Error('mcp-portal: OpenClaw did not provide a trusted agentId.');
			}
			const core = await props.getCore();
			const scope = core.createAgentScope({
				agentId: props.context.agentId,
				agentScopeId: props.context.agentId,
				...(props.context.sessionId ? { sessionId: props.context.sessionId } : {}),
				...(props.context.sessionKey ? { sessionKey: props.context.sessionKey } : {}),
				source: 'openclaw-trusted',
			});
			const result = await core.collectPortalCoreResult(
				core.callStream({
					input: params,
					scope,
					...(signal !== undefined ? { signal } : {}),
					toolName: props.descriptor.name,
				}),
				{ onEvent: (event) => forwardCoreEvent(event, props.logger, onUpdate) },
			);
			return { content: JSON.stringify(result), details: result };
		},
		label: props.descriptor.name,
		name: props.descriptor.name,
		parameters: props.descriptor.inputSchema,
	};
}

function descriptorsForOpenClawContext(props: {
	readonly context: OpenClawPluginToolContext;
	readonly portalConfig: McpPortalConfig | null;
}): readonly PortalCoreToolDescriptor[] {
	if (props.portalConfig === null || props.context.agentId === undefined) {
		return listPortalCoreToolDescriptors();
	}
	const agent = props.portalConfig.agents[props.context.agentId];
	if (agent === undefined) {
		return listPortalCoreToolDescriptors();
	}
	const profile = resolveMcpPortalProfile(props.portalConfig, agent.profile);
	return listPortalCoreToolDescriptors(profile.enabledNamespaces);
}

function registerNativePortalTools(props: {
	readonly api: OpenClawPortalPluginApi;
	readonly getCore: () => Promise<PortalCore>;
	readonly runtimeState: ReturnType<typeof createPortalPluginRuntimeState>;
}): void {
	const descriptorNames = listPortalCoreToolDescriptors().map((descriptor) => descriptor.name);
	const logger = createLoggerAdapter(props.api);
	props.api.registerTool?.(
		(context) => {
			const descriptors = descriptorsForOpenClawContext({
				context,
				portalConfig: props.runtimeState.getLoadedPortalConfig(),
			});
			return descriptors.map((descriptor) =>
				createNativeTool({ context, descriptor, getCore: props.getCore, logger }),
			);
		},
		{
			names: descriptorNames,
			optional: true,
		},
	);
}

function shouldRegisterPortalRuntimeHooks(api: OpenClawPortalPluginApi): boolean {
	return api.registrationMode === undefined || api.registrationMode === 'full';
}

function formatRegistrationMode(api: OpenClawPortalPluginApi): string {
	return api.registrationMode ?? 'full';
}

export function registerMcpPortalPlugin(api: OpenClawPortalPluginApi): void {
	const logger = createLoggerAdapter(api);
	const registerRuntimeHooks = shouldRegisterPortalRuntimeHooks(api);
	if (registerRuntimeHooks) {
		validatePortalPluginApi(api);
	} else if (!hasFunction(api.registerTool)) {
		logger.warn(
			`[mcp-portal] skipped native portal tool registration for registrationMode='${formatRegistrationMode(api)}' because OpenClaw did not expose registerTool.`,
		);
		return;
	}
	const configDir = resolveConfigDir(api);
	const runtimeState = createPortalPluginRuntimeState({ configDir });
	let corePromise: Promise<PortalCore> | undefined;
	const getCore = (): Promise<PortalCore> => {
		corePromise ??= createManagedPortalCore(configDir, runtimeState).catch((error: unknown) => {
			corePromise = undefined;
			throw error;
		});
		return corePromise;
	};
	registerNativePortalTools({ api, getCore, runtimeState });

	if (!registerRuntimeHooks) {
		logger.info(
			`[mcp-portal] registered native portal tools for registrationMode='${formatRegistrationMode(api)}'.`,
		);
		return;
	}

	api.on?.(
		'before_tool_call',
		createBeforeToolCallHandler({
			logger,
			resolveApprovalTokenCallDigests: async ({ agentId, approvalCalls, context, params }) => {
				const core = await getCore();
				const scope = core.createAgentScope({
					agentId,
					agentScopeId: agentId,
					...(context.sessionId ? { sessionId: context.sessionId } : {}),
					...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
					source: 'openclaw-trusted',
				});
				const digestsByCallId = await core.approval.prepareCallDigests({ input: params, scope });
				if (digestsByCallId === null) {
					throw new Error('MCP Portal core could not prepare approval token digests.');
				}
				return approvalCalls.map((call) => {
					const digest = digestsByCallId[call.id];
					if (digest === undefined) {
						throw new Error(
							`MCP Portal core did not prepare an approval token digest for call '${call.id}'.`,
						);
					}
					return digest;
				});
			},
			runtimeState,
		}),
		{
			priority: 80,
		},
	);

	api.on?.('before_prompt_build', createBeforePromptBuildHandler({ runtimeState }), {
		priority: 80,
	});

	if (!api.on && api.registerPromptHook) {
		api.registerPromptHook('before_prompt_build', async (context) => {
			const handler = createBeforePromptBuildHandler({ runtimeState });
			const result = await handler({}, context);
			if (result?.appendSystemContext !== undefined) {
				context.appendPrompt?.(result.appendSystemContext);
			}
		});
	}

	registerPortalRuntimeCleanup(api, async () => {
		const core = await corePromise?.catch(() => undefined);
		await core?.close();
	});
	logger.info('[mcp-portal] registered native portal tools and runtime hooks.');
}

const pluginEntry = {
	description: 'Registers native OpenClaw MCP Portal tools and wires per-agent approval hooks.',
	id: pluginId,
	name: 'MCP Portal',
	register: registerMcpPortalPlugin,
} satisfies PortalPluginEntry;

export default pluginEntry;
