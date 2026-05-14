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
	if (!hasFunction(api.onDispose)) {
		throw new Error('MCP Portal plugin requires an OpenClaw lifecycle cleanup API.');
	}
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
					props.api.logger?.error?.(`[mcp-portal] subprocess supervisor fatal: ${reason}`);
				},
				port: mcpPortalConfig.server.port,
			});
			await supervisor.start();
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

	api.on?.('before_tool_call', createBeforeToolCallHandler({ runtimeState }), { priority: 80 });

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

	api.onDispose?.(() => registeredService.getSupervisor()?.stop());
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
