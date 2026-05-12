import { readFile } from 'node:fs/promises';

import {
	createPortalBindingId,
	createPortalServerName,
	materializedPortalToolNames,
} from '@agent-vm/openclaw-mcp-portal-plugin';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { DoctorCheck } from './doctor.js';

type OpenClawSystemZone = LoadedSystemConfig['zones'][number] & {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'openclaw' }
	>;
};

interface OpenClawDeploymentConfig {
	readonly [key: string]: unknown;
	readonly agents?: {
		readonly defaults?: {
			readonly model?: unknown;
			readonly sandbox?: {
				readonly [key: string]: unknown;
				readonly workspaceAccess?: unknown;
			};
			readonly workspace?: unknown;
		};
		readonly list?: readonly unknown[];
	};
	readonly gateway?: {
		readonly port?: unknown;
	};
	readonly mcp?: {
		readonly servers?: Record<string, unknown>;
	};
	readonly plugins?: {
		readonly allow?: readonly unknown[];
		readonly entries?: Record<string, unknown>;
		readonly load?: {
			readonly paths?: readonly unknown[];
		};
		readonly slots?: {
			readonly memory?: unknown;
		};
	};
}

const defaultOpenClawGatewayPort = 18789;
const portalSecretHeader = 'x-mcp-portal-binding-secret';

export interface OpenClawDeploymentDoctorTarget {
	readonly configuredAuthProfileAgentIds?: readonly string[];
	readonly config: OpenClawDeploymentConfig;
	readonly configPath?: string;
	readonly configReadError?: string;
	readonly zoneId: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includesString(values: readonly unknown[] | undefined, expectedValue: string): boolean {
	return values?.some((value) => value === expectedValue) === true;
}

function hasEnabledEntry(
	entries: Record<string, unknown> | undefined,
	pluginName: string,
): boolean {
	const entry = entries?.[pluginName];
	return isObjectRecord(entry) && entry.enabled === true;
}

function entryAllowsPromptInjection(
	entries: Record<string, unknown> | undefined,
	pluginName: string,
): boolean {
	const entry = entries?.[pluginName];
	if (!isObjectRecord(entry)) {
		return false;
	}
	const hooks = entry.hooks;
	return isObjectRecord(hooks) && hooks.allowPromptInjection === true;
}

function parseOpenClawDeploymentConfig(rawConfig: string): OpenClawDeploymentConfig {
	const parsedConfig: unknown = JSON.parse(rawConfig);
	return isObjectRecord(parsedConfig) ? parsedConfig : {};
}

function resolveOpenClawModelName(model: unknown): string | undefined {
	if (typeof model === 'string') {
		return model;
	}
	if (!isObjectRecord(model)) {
		return undefined;
	}
	return typeof model.primary === 'string' ? model.primary : undefined;
}

function isOpenAiCodexModel(modelName: string | undefined): boolean {
	return modelName?.startsWith('openai-codex/') === true || modelName === 'openai-codex';
}

function collectOpenClawCodexAgentIds(config: OpenClawDeploymentConfig): readonly string[] {
	const defaultModelName = resolveOpenClawModelName(config.agents?.defaults?.model);
	return (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.filter((agent) =>
			isOpenAiCodexModel(resolveOpenClawModelName(agent.model) ?? defaultModelName),
		)
		.map((agent) => agent.id)
		.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0);
}

function portalBindingToolNames(agentId: string): readonly string[] {
	return materializedPortalToolNames(createPortalServerName(agentId));
}

function collectConfiguredAgentIds(config: OpenClawDeploymentConfig): readonly string[] {
	return (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.map((agent) => agent.id)
		.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0);
}

function openClawGatewayBaseUrl(config: OpenClawDeploymentConfig): string {
	const port = config.gateway?.port;
	const gatewayPort =
		typeof port === 'number' && Number.isInteger(port) && port > 0
			? port
			: defaultOpenClawGatewayPort;
	return `http://127.0.0.1:${gatewayPort}`;
}

function expectedPortalServerUrl(config: OpenClawDeploymentConfig, agentId: string): string {
	return `${openClawGatewayBaseUrl(config)}/mcp-portal/bindings/${createPortalBindingId(agentId)}/mcp`;
}

function isPortalServerName(serverName: string): boolean {
	return serverName.startsWith('mcp_portal_');
}

function hasExpectedPortalServer(config: OpenClawDeploymentConfig, agentId: string): boolean {
	const server = config.mcp?.servers?.[createPortalServerName(agentId)];
	if (!isObjectRecord(server)) {
		return false;
	}
	const headers = server.headers;
	const bindingSecret = isObjectRecord(headers) ? headers[portalSecretHeader] : undefined;
	return (
		server.transport === 'streamable-http' &&
		server.url === expectedPortalServerUrl(config, agentId) &&
		typeof bindingSecret === 'string' &&
		bindingSecret.length > 0
	);
}

function hasNoOrphanPortalServers(config: OpenClawDeploymentConfig): boolean {
	const servers = config.mcp?.servers ?? {};
	const expectedServerNames = new Set(
		collectConfiguredAgentIds(config).map((agentId) => createPortalServerName(agentId)),
	);
	return Object.keys(servers).every(
		(serverName) => !isPortalServerName(serverName) || expectedServerNames.has(serverName),
	);
}

function portalDenyListForAgent(
	config: OpenClawDeploymentConfig,
	agentId: string,
): readonly unknown[] {
	const agent = (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.find((candidate) => candidate.id === agentId);
	return isObjectRecord(agent?.tools) && Array.isArray(agent.tools.deny) ? agent.tools.deny : [];
}

function hasValidPortalBindingTopology(config: OpenClawDeploymentConfig, agentId: string): boolean {
	if (!hasExpectedPortalServer(config, agentId)) {
		return false;
	}

	const configuredAgentIds = collectConfiguredAgentIds(config);
	const deniedTools = portalDenyListForAgent(config, agentId);
	const ownTools = portalBindingToolNames(agentId);
	const siblingTools = configuredAgentIds
		.filter((candidateAgentId) => candidateAgentId !== agentId)
		.flatMap((candidateAgentId) => portalBindingToolNames(candidateAgentId));
	return (
		ownTools.every((toolName) => !deniedTools.includes(toolName)) &&
		siblingTools.every((toolName) => deniedTools.includes(toolName))
	);
}

function buildAgentAuthProfileChecks(
	target: OpenClawDeploymentDoctorTarget,
): readonly DoctorCheck[] {
	const configuredAuthProfileAgentIds = new Set(target.configuredAuthProfileAgentIds ?? []);
	return collectOpenClawCodexAgentIds(target.config).map((agentId) => {
		const hasAuthProfile = configuredAuthProfileAgentIds.has(agentId);
		return {
			name: `openclaw-agent-auth-profile-${target.zoneId}-${agentId}`,
			ok: hasAuthProfile,
			hint: hasAuthProfile
				? `auth profile configured for agent ${agentId}`
				: `Configure gateway.authProfilesByAgent.${agentId} or run OpenClaw auth onboarding for agent ${agentId}.`,
		} satisfies DoctorCheck;
	});
}

function buildConfigReadableCheck(target: OpenClawDeploymentDoctorTarget): DoctorCheck | undefined {
	if (target.configPath === undefined && target.configReadError === undefined) {
		return undefined;
	}
	return {
		name: `openclaw-deployment-config-readable-${target.zoneId}`,
		ok: target.configReadError === undefined,
		hint:
			target.configReadError === undefined
				? (target.configPath ?? 'OpenClaw config is readable')
				: `Cannot read ${target.configPath ?? 'OpenClaw config'}: ${target.configReadError}`,
	};
}

export function buildOpenClawDeploymentDoctorChecks(
	targets: readonly OpenClawDeploymentDoctorTarget[],
): readonly DoctorCheck[] {
	return targets.flatMap((target) => {
		const config = target.config;
		const configReadableCheck = buildConfigReadableCheck(target);
		const pluginLoadPaths = config.plugins?.load?.paths;
		const hasMemoryCore =
			includesString(config.plugins?.allow, 'memory-core') ||
			hasEnabledEntry(config.plugins?.entries, 'memory-core');
		const workspace = config.agents?.defaults?.workspace;
		return [
			...(configReadableCheck ? [configReadableCheck] : []),
			{
				name: `openclaw-workspace-access-${target.zoneId}`,
				ok: config.agents?.defaults?.sandbox?.workspaceAccess === 'rw',
				hint:
					config.agents?.defaults?.sandbox?.workspaceAccess === 'rw'
						? 'agents.defaults.sandbox.workspaceAccess=rw'
						: 'Set agents.defaults.sandbox.workspaceAccess to "rw" so agents can write their workspace.',
			},
			{
				name: `openclaw-plugin-load-paths-${target.zoneId}`,
				ok: includesString(pluginLoadPaths, '/home/openclaw/.openclaw/extensions/gondolin'),
				hint: 'Add plugins.load.paths for /home/openclaw/.openclaw/extensions/gondolin.',
			},
			{
				name: `openclaw-mcp-portal-load-path-${target.zoneId}`,
				ok: includesString(pluginLoadPaths, '/home/openclaw/.openclaw/extensions/mcp-portal'),
				hint: 'Add plugins.load.paths for /home/openclaw/.openclaw/extensions/mcp-portal.',
			},
			{
				name: `openclaw-mcp-portal-allowed-${target.zoneId}`,
				ok:
					includesString(config.plugins?.allow, 'mcp-portal') &&
					hasEnabledEntry(config.plugins?.entries, 'mcp-portal'),
				hint: 'Allow and enable the mcp-portal plugin.',
			},
			{
				name: `openclaw-mcp-portal-prompt-injection-${target.zoneId}`,
				ok: entryAllowsPromptInjection(config.plugins?.entries, 'mcp-portal'),
				hint: 'Set plugins.entries.mcp-portal.hooks.allowPromptInjection=true.',
			},
			{
				name: `openclaw-mcp-portal-agent-bindings-${target.zoneId}`,
				ok:
					hasNoOrphanPortalServers(config) &&
					collectConfiguredAgentIds(config).every((agentId) =>
						hasValidPortalBindingTopology(config, agentId),
					),
				hint: 'Generate one mcp.servers portal binding per OpenClaw agent and deny sibling portal tool names on each agent.',
			},
			{
				name: `openclaw-memory-slot-${target.zoneId}`,
				ok: !hasMemoryCore || config.plugins?.slots?.memory === 'memory-core',
				hint:
					!hasMemoryCore || config.plugins?.slots?.memory === 'memory-core'
						? 'plugins.slots.memory=memory-core'
						: 'Set plugins.slots.memory to "memory-core" when memory-core is enabled.',
			},
			{
				name: `openclaw-shared-zone-workspace-${target.zoneId}`,
				ok: workspace !== '/zone',
				hint:
					workspace === '/zone'
						? 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.'
						: typeof workspace === 'string'
							? workspace
							: 'agents.defaults.workspace is unset',
			},
			...buildAgentAuthProfileChecks(target),
		] as const satisfies readonly DoctorCheck[];
	});
}

function isOpenClawSystemZone(
	zone: LoadedSystemConfig['zones'][number],
): zone is OpenClawSystemZone {
	return zone.gateway.type === 'openclaw';
}

export async function collectOpenClawDeploymentDoctorChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly DoctorCheck[]> {
	const targets = await Promise.all(
		systemConfig.zones.filter(isOpenClawSystemZone).map(async (zone) => {
			const configuredAuthProfileAgentIds = Object.keys(zone.gateway.authProfilesByAgent ?? {});
			const configPath = zone.gateway.config;
			try {
				const rawConfig = await readFile(configPath, 'utf8');
				return {
					zoneId: zone.id,
					configPath,
					configuredAuthProfileAgentIds,
					config: parseOpenClawDeploymentConfig(rawConfig),
				} satisfies OpenClawDeploymentDoctorTarget;
			} catch (error) {
				return {
					zoneId: zone.id,
					configPath,
					configuredAuthProfileAgentIds,
					config: {},
					configReadError: error instanceof Error ? error.message : String(error),
				} satisfies OpenClawDeploymentDoctorTarget;
			}
		}),
	);
	return buildOpenClawDeploymentDoctorChecks(targets);
}
