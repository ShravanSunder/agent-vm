import { join } from 'node:path';

import {
	loadMcpConfig,
	type McpConfig,
	type McpPortalConfig,
	type SecretValue,
} from '@agent-vm/config-contracts';

import { createBeforePromptBuildHandler } from './before-prompt-build-handler.js';
import { createBeforeToolCallHandler } from './before-tool-call-handler.js';
import { createHmacKeyRegistry } from './hmac-key-registry.js';
import type { OpenClawPortalPluginApi } from './openclaw-plugin-api.js';
import { parsePortalConfig } from './portal-config.js';
import {
	createPortalPluginRuntimeState,
	type PortalPluginRuntimeState,
} from './portal-plugin-runtime-state.js';
import {
	createPortalSubprocessSupervisor,
	type PortalSubprocessSupervisor,
} from './portal-subprocess-supervisor.js';

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

const pluginId = 'mcp-portal';
const onePasswordCliEnvNames = [
	'OP_SERVICE_ACCOUNT_TOKEN',
	'OP_ACCOUNT',
	'OP_CONNECT_HOST',
	'OP_CONNECT_TOKEN',
] as const;

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

function messageFromUnknown(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function addEnvironmentSecretName(names: Set<string>, secret: SecretValue): void {
	if (secret.source === 'environment') {
		names.add(secret.name);
	}
}

function secretUsesOnePassword(secret: SecretValue): boolean {
	return secret.source === '1password';
}

function collectMcpConfigEnvironmentSecretNames(config: McpConfig): ReadonlySet<string> {
	const names = new Set<string>();
	for (const provider of Object.values(config.providers)) {
		const transport = provider.transport;
		const secrets =
			transport.kind === 'stdio' ? Object.values(transport.env) : Object.values(transport.headers);
		for (const secret of secrets) {
			addEnvironmentSecretName(names, secret);
		}
	}
	return names;
}

function collectMcpPortalConfigEnvironmentSecretNames(
	config: McpPortalConfig,
): ReadonlySet<string> {
	const names = new Set<string>();
	addEnvironmentSecretName(names, config.server.accessHeader.secret);
	for (const agent of Object.values(config.agents)) {
		if (agent.hmacKey !== undefined) {
			addEnvironmentSecretName(names, agent.hmacKey);
		}
	}
	return names;
}

function mcpConfigUsesOnePassword(config: McpConfig): boolean {
	return Object.values(config.providers).some((provider) => {
		const transport = provider.transport;
		const secrets =
			transport.kind === 'stdio' ? Object.values(transport.env) : Object.values(transport.headers);
		return secrets.some(secretUsesOnePassword);
	});
}

function mcpPortalConfigUsesOnePassword(config: McpPortalConfig): boolean {
	return (
		secretUsesOnePassword(config.server.accessHeader.secret) ||
		Object.values(config.agents).some(
			(agent) => agent.hmacKey !== undefined && secretUsesOnePassword(agent.hmacKey),
		)
	);
}

function resolveRequiredPortalEnv(props: {
	readonly env: NodeJS.ProcessEnv;
	readonly names: ReadonlySet<string>;
}): Readonly<Record<string, string>> {
	const resolvedEnv: Record<string, string> = {};
	for (const name of [...props.names].toSorted()) {
		const value = props.env[name];
		if (value === undefined || value.length === 0) {
			throw new Error(`Missing environment secret ${name} for MCP Portal subprocess.`);
		}
		resolvedEnv[name] = value;
	}
	return resolvedEnv;
}

export function createPortalSubprocessConfigEnv(props: {
	readonly env?: NodeJS.ProcessEnv;
	readonly mcpConfig: McpConfig;
	readonly mcpPortalConfig: McpPortalConfig;
}): Readonly<Record<string, string>> {
	const env = props.env ?? process.env;
	const requiredNames = new Set<string>([
		...collectMcpConfigEnvironmentSecretNames(props.mcpConfig),
		...collectMcpPortalConfigEnvironmentSecretNames(props.mcpPortalConfig),
	]);
	const portalEnv: Record<string, string> = {
		...resolveRequiredPortalEnv({ env, names: requiredNames }),
	};
	if (
		mcpConfigUsesOnePassword(props.mcpConfig) ||
		mcpPortalConfigUsesOnePassword(props.mcpPortalConfig)
	) {
		for (const name of onePasswordCliEnvNames) {
			const value = env[name];
			if (value !== undefined && value.length > 0) {
				portalEnv[name] = value;
			}
		}
	}
	return portalEnv;
}

function resolveConfigDir(api: OpenClawPortalPluginApi): string {
	const pluginConfig = parsePortalConfig(api.pluginConfig ?? {});
	if (pluginConfig.configDir !== undefined) {
		return pluginConfig.configDir;
	}
	const topLevelMcpConfigDir = getObjectProperty(getObjectProperty(api.config, 'mcp'), 'configDir');
	if (typeof topLevelMcpConfigDir === 'string' && topLevelMcpConfigDir.length > 0) {
		return topLevelMcpConfigDir;
	}
	const zones = getObjectProperty(api.config, 'zones');
	if (isUnknownArray(zones)) {
		const firstZone = zones.at(0);
		const zoneMcpConfigDir = getObjectProperty(getObjectProperty(firstZone, 'mcp'), 'configDir');
		if (typeof zoneMcpConfigDir === 'string' && zoneMcpConfigDir.length > 0) {
			return zoneMcpConfigDir;
		}
	}
	throw new Error('MCP Portal plugin requires configDir in plugin config or zone mcp config.');
}

function tcpPoolConfigFromApi(api: OpenClawPortalPluginApi): TcpPoolConfig | null {
	const tcpPool = getObjectProperty(api.config, 'tcpPool');
	const basePort = getObjectProperty(tcpPool, 'basePort');
	const size = getObjectProperty(tcpPool, 'size');
	return typeof basePort === 'number' && typeof size === 'number' ? { basePort, size } : null;
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
	if (!hasFunction(api.registerService)) {
		throw new Error('MCP Portal plugin requires OpenClaw registerService API.');
	}
	if (!hasFunction(api.on) && !hasFunction(api.registerPromptHook)) {
		throw new Error('MCP Portal plugin requires OpenClaw prompt hook registration API.');
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
		description: 'Stops the MCP Portal subprocess supervised by the agent-vm plugin.',
		id: 'mcp-portal-subprocess',
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

function registerPortalService(props: {
	readonly api: OpenClawPortalPluginApi;
	readonly configDir: string;
	readonly runtimeState: PortalPluginRuntimeState;
}): { readonly getSupervisor: () => PortalSubprocessSupervisor | null } {
	const portalConfig = parsePortalConfig(props.api.pluginConfig ?? {});
	let supervisor: PortalSubprocessSupervisor | null = null;

	props.api.registerService?.({
		id: 'mcp-portal-subprocess',
		start: async () => {
			const mcpPortalConfig = await props.runtimeState.loadPortalConfig();
			const mcpConfig = await loadMcpConfig(join(props.configDir, 'mcp.config.jsonc'));
			validatePortalPortAgainstTcpPool({
				port: mcpPortalConfig.server.port,
				tcpPool: tcpPoolConfigFromApi(props.api),
			});
			const keyRegistry = createHmacKeyRegistry({
				agentIds: Object.keys(mcpPortalConfig.agents).toSorted(),
			});
			props.runtimeState.setKeyRegistry(keyRegistry);
			supervisor = createPortalSubprocessSupervisor({
				binPath: portalConfig.binPath,
				configDir: props.configDir,
				host: mcpPortalConfig.server.host,
				hmacEnv: keyRegistry.serializeForEnv(),
				logger: createLoggerAdapter(props.api),
				onFatal: (reason) => {
					props.runtimeState.markPortalUnavailable(reason);
					props.api.logger?.error?.(`[mcp-portal] subprocess supervisor fatal: ${reason}`);
				},
				port: mcpPortalConfig.server.port,
				portalEnv: createPortalSubprocessConfigEnv({ mcpConfig, mcpPortalConfig }),
			});
			await supervisor.start();
			props.runtimeState.markPortalAvailable();
		},
		stop: async () => {
			await supervisor?.stop();
		},
	});

	return { getSupervisor: () => supervisor };
}

export function registerMcpPortalPlugin(api: OpenClawPortalPluginApi): void {
	if (api.registrationMode !== undefined && api.registrationMode !== 'full') {
		return;
	}
	validatePortalPluginApi(api);
	const configDir = resolveConfigDir(api);
	const runtimeState = createPortalPluginRuntimeState({ configDir });
	const registeredService = registerPortalService({ api, configDir, runtimeState });

	api.on?.(
		'before_tool_call',
		createBeforeToolCallHandler({ logger: createLoggerAdapter(api), runtimeState }),
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

	registerPortalRuntimeCleanup(api, () => registeredService.getSupervisor()?.stop());
	void runtimeState.loadPortalConfig().catch((error: unknown) => {
		api.logger?.error?.(
			`[mcp-portal] failed to initialize portal config: ${messageFromUnknown(error)}`,
		);
	});
}

const pluginEntry = {
	description: 'Supervises the MCP Portal subprocess and wires per-agent approval hooks.',
	id: pluginId,
	name: 'MCP Portal',
	register: registerMcpPortalPlugin,
} satisfies PortalPluginEntry;

export default pluginEntry;
