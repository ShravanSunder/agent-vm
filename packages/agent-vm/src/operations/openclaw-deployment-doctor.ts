import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { loadMcpPortalConfig } from '@agent-vm/config-contracts';
import {
	materializedPortalToolNames,
	portalServerNameForAgent,
} from '@agent-vm/openclaw-mcp-portal-plugin';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { DoctorCheck } from './doctor.js';
import {
	collectOpenClawDeploymentRequirementTargets,
	evaluateOpenClawDeploymentRequirements,
	isObjectRecord,
	type OpenClawDeploymentConfig,
	type OpenClawDeploymentRequirementTarget,
} from './openclaw-deployment-requirements.js';

type OpenClawSystemZone = LoadedSystemConfig['zones'][number] & {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'openclaw' }
	>;
};

interface PortalServerExpectation {
	readonly accessHeaderName: string;
	readonly host: string;
	readonly port: number;
}

const defaultPortalServerExpectation: PortalServerExpectation = {
	accessHeaderName: 'x-agent-vm-mcp-portal-secret',
	host: '127.0.0.1',
	port: 18790,
};

export interface OpenClawDeploymentDoctorTarget {
	readonly configuredAuthProfileAgentIds?: readonly string[];
	readonly configuredCodexHarnessAuthAgentIds?: readonly string[];
	readonly config: OpenClawDeploymentConfig;
	readonly configPath?: string | undefined;
	readonly configReadError?: string | undefined;
	readonly portalServer?: PortalServerExpectation;
	readonly zoneId: OpenClawDeploymentRequirementTarget['zoneId'];
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

function hasOnlyRuntimePortalPluginConfig(entries: Record<string, unknown> | undefined): boolean {
	const entry = entries?.['mcp-portal'];
	if (!isObjectRecord(entry)) {
		return true;
	}
	const config = entry.config;
	if (config === undefined) {
		return true;
	}
	if (!isObjectRecord(config)) {
		return false;
	}
	const runtimeKeys = new Set(['configDir', 'binPath']);
	return Object.keys(config).every((key) => runtimeKeys.has(key));
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

function portalEndpointToolNames(agentId: string): readonly string[] {
	return materializedPortalToolNames(portalServerNameForAgent(agentId));
}

function collectConfiguredAgentIds(config: OpenClawDeploymentConfig): readonly string[] {
	return (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.map((agent) => agent.id)
		.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0);
}

function expectedPortalServerUrl(portalServer: PortalServerExpectation, agentId: string): string {
	return `http://${portalServer.host}:${String(portalServer.port)}/agents/${encodeURIComponent(agentId)}/mcp`;
}

function readMcpServers(config: OpenClawDeploymentConfig): Readonly<Record<string, unknown>> {
	const mcp = config.mcp;
	if (!isObjectRecord(mcp)) {
		return {};
	}
	const servers = mcp.servers;
	return isObjectRecord(servers) ? servers : {};
}

function isPortalServerName(serverName: string): boolean {
	return serverName.startsWith('mcp_portal_');
}

function hasExpectedPortalServer(
	config: OpenClawDeploymentConfig,
	agentId: string,
	portalServer: PortalServerExpectation,
): boolean {
	const server = readMcpServers(config)[portalServerNameForAgent(agentId)];
	if (!isObjectRecord(server)) {
		return false;
	}
	const headers = server.headers;
	const accessHeaderValue = isObjectRecord(headers)
		? headers[portalServer.accessHeaderName]
		: undefined;
	return (
		server.transport === 'streamable-http' &&
		server.url === expectedPortalServerUrl(portalServer, agentId) &&
		typeof accessHeaderValue === 'string' &&
		accessHeaderValue.length > 0
	);
}

function hasNoOrphanPortalServers(config: OpenClawDeploymentConfig): boolean {
	const servers = readMcpServers(config);
	const expectedServerNames = new Set(
		collectConfiguredAgentIds(config).map((agentId) => portalServerNameForAgent(agentId)),
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

function hasValidPortalEndpointTopology(
	config: OpenClawDeploymentConfig,
	agentId: string,
	portalServer: PortalServerExpectation,
): boolean {
	if (!hasExpectedPortalServer(config, agentId, portalServer)) {
		return false;
	}

	const configuredAgentIds = collectConfiguredAgentIds(config);
	const deniedTools = portalDenyListForAgent(config, agentId);
	const ownTools = portalEndpointToolNames(agentId);
	const siblingTools = configuredAgentIds
		.filter((candidateAgentId) => candidateAgentId !== agentId)
		.flatMap((candidateAgentId) => portalEndpointToolNames(candidateAgentId));
	return (
		ownTools.every((toolName) => !deniedTools.includes(toolName)) &&
		siblingTools.every((toolName) => deniedTools.includes(toolName))
	);
}

function buildAgentAuthProfileChecks(
	target: OpenClawDeploymentDoctorTarget,
): readonly DoctorCheck[] {
	const configuredAuthProfileAgentIds = new Set(target.configuredAuthProfileAgentIds ?? []);
	const configuredCodexHarnessAuthAgentIds = new Set(
		target.configuredCodexHarnessAuthAgentIds ?? [],
	);
	return collectOpenClawCodexAgentIds(target.config).map((agentId) => {
		const hasAuthProfile = configuredAuthProfileAgentIds.has(agentId);
		const hasCodexHarnessAuth = configuredCodexHarnessAuthAgentIds.has(agentId);
		const hasAuthMaterial = hasAuthProfile || hasCodexHarnessAuth;
		return {
			name: `openclaw-agent-auth-profile-${target.zoneId}-${agentId}`,
			ok: hasAuthMaterial,
			hint: hasAuthProfile
				? `OpenClaw auth profile configured for agent ${agentId}`
				: hasCodexHarnessAuth
					? `Codex harness auth.json present for agent ${agentId}`
					: `Run agent-vm auth codex-harness --zone ${target.zoneId} --agent ${agentId} or configure gateway.authProfilesByAgent.${agentId}.`,
		} satisfies DoctorCheck;
	});
}

function buildRequirementChecks(target: OpenClawDeploymentDoctorTarget): readonly DoctorCheck[] {
	const requirementTarget: OpenClawDeploymentRequirementTarget =
		target.configReadError === undefined
			? {
					config: target.config,
					...(target.configPath ? { configPath: target.configPath } : {}),
					kind: 'readable',
					zoneId: target.zoneId,
				}
			: {
					...(target.configPath ? { configPath: target.configPath } : {}),
					configReadError: target.configReadError,
					kind: 'unreadable',
					zoneId: target.zoneId,
				};
	return evaluateOpenClawDeploymentRequirements(requirementTarget).map(
		(finding) =>
			({
				name: finding.id,
				ok: finding.ok,
				hint: finding.hint,
			}) satisfies DoctorCheck,
	);
}

export function buildOpenClawDeploymentDoctorChecks(
	targets: readonly OpenClawDeploymentDoctorTarget[],
): readonly DoctorCheck[] {
	return targets.flatMap((target) => {
		const requirementChecks = buildRequirementChecks(target);
		if (target.configReadError !== undefined) {
			return requirementChecks;
		}
		const config = target.config;
		const portalServer = target.portalServer ?? defaultPortalServerExpectation;
		const pluginLoadPaths = config.plugins?.load?.paths;
		const hasMemoryCore =
			includesString(config.plugins?.allow, 'memory-core') ||
			hasEnabledEntry(config.plugins?.entries, 'memory-core');
		const configuredAgentIds = collectConfiguredAgentIds(config);
		return [
			...requirementChecks,
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
				name: `openclaw-mcp-portal-config-source-${target.zoneId}`,
				ok: hasOnlyRuntimePortalPluginConfig(config.plugins?.entries),
				hint: 'Move MCP Portal namespace/tool policy to mcp-portal.config.jsonc; OpenClaw plugin config may only carry configDir/binPath.',
			},
			{
				name: `openclaw-mcp-portal-agent-endpoints-${target.zoneId}`,
				ok:
					configuredAgentIds.length > 0 &&
					hasNoOrphanPortalServers(config) &&
					configuredAgentIds.every((agentId) =>
						hasValidPortalEndpointTopology(config, agentId, portalServer),
					),
				hint: 'Generate one mcp.servers portal endpoint per OpenClaw agent and deny sibling portal tool names on each agent.',
			},
			{
				name: `openclaw-memory-slot-${target.zoneId}`,
				ok: !hasMemoryCore || config.plugins?.slots?.memory === 'memory-core',
				hint:
					!hasMemoryCore || config.plugins?.slots?.memory === 'memory-core'
						? 'plugins.slots.memory=memory-core'
						: 'Set plugins.slots.memory to "memory-core" when memory-core is enabled.',
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

async function loadPortalServerExpectation(
	zone: OpenClawSystemZone,
): Promise<PortalServerExpectation | undefined> {
	if (zone.mcp === undefined) {
		return undefined;
	}
	try {
		const portalConfig = await loadMcpPortalConfig(
			join(zone.mcp.configDir, 'mcp-portal.config.jsonc'),
		);
		return {
			accessHeaderName: portalConfig.server.accessHeader.name,
			host: portalConfig.server.host,
			port: portalConfig.server.port,
		};
	} catch {
		return undefined;
	}
}

async function collectCodexHarnessAuthAgentIds(
	zone: OpenClawSystemZone,
	config: OpenClawDeploymentConfig,
): Promise<readonly string[]> {
	const agentIds: string[] = [];
	for (const agentId of collectOpenClawCodexAgentIds(config)) {
		const authJsonPath = join(
			zone.gateway.stateDir,
			'agents',
			agentId,
			'agent',
			'codex-home',
			'auth.json',
		);
		try {
			// Auth contents are secret; doctor only checks file presence.
			// oxlint-disable-next-line no-await-in-loop -- each agent maps to a separate auth path
			await access(authJsonPath);
			agentIds.push(agentId);
		} catch {
			// Missing auth.json is reported by buildAgentAuthProfileChecks.
		}
	}
	return agentIds;
}

export async function collectOpenClawDeploymentDoctorChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly DoctorCheck[]> {
	const openClawZones = systemConfig.zones.filter(isOpenClawSystemZone);
	const configuredAuthProfileAgentIdsByZone = new Map(
		openClawZones.map(
			(zone) => [zone.id, Object.keys(zone.gateway.authProfilesByAgent ?? {})] as const,
		),
	);
	const portalServerByZone = new Map(
		(
			await Promise.all(
				openClawZones.map(
					async (zone) => [zone.id, await loadPortalServerExpectation(zone)] as const,
				),
			)
		).filter(
			(entry): entry is readonly [string, PortalServerExpectation] => entry[1] !== undefined,
		),
	);
	const targets = await collectOpenClawDeploymentRequirementTargets(systemConfig);
	const doctorTargets = await Promise.all(
		targets.map(async (target): Promise<OpenClawDeploymentDoctorTarget> => {
			const zone = openClawZones.find((candidate) => candidate.id === target.zoneId);
			const codexHarnessAuthAgentIds =
				target.kind === 'readable' && zone
					? await collectCodexHarnessAuthAgentIds(zone, target.config)
					: [];
			const baseTarget =
				target.kind === 'readable'
					? {
							config: target.config,
							configuredCodexHarnessAuthAgentIds: codexHarnessAuthAgentIds,
							configuredAuthProfileAgentIds:
								configuredAuthProfileAgentIdsByZone.get(target.zoneId) ?? [],
							configPath: target.configPath,
							zoneId: target.zoneId,
						}
					: {
							config: {},
							configuredCodexHarnessAuthAgentIds: codexHarnessAuthAgentIds,
							configuredAuthProfileAgentIds:
								configuredAuthProfileAgentIdsByZone.get(target.zoneId) ?? [],
							configPath: target.configPath,
							configReadError: target.configReadError,
							zoneId: target.zoneId,
						};
			const portalServer = portalServerByZone.get(target.zoneId);
			return portalServer === undefined ? baseTarget : Object.assign(baseTarget, { portalServer });
		}),
	);
	return buildOpenClawDeploymentDoctorChecks(doctorTargets);
}
