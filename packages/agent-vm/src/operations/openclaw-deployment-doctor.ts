import { access } from 'node:fs/promises';
import { join } from 'node:path';

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

interface CodexHarnessAuthReadError {
	readonly agentId: string;
	readonly message: string;
	readonly path: string;
}

interface CodexHarnessAuthScan {
	readonly agentIds: readonly string[];
	readonly readErrors: readonly CodexHarnessAuthReadError[];
}

const openClawGondolinPluginLoadPath = '/home/openclaw/.openclaw/extensions/gondolin';
const openClawManagedPackageLoadPath = '/pnpm/global/5/node_modules/@openclaw';

export interface OpenClawDeploymentDoctorTarget {
	readonly configuredAuthProfileAgentIds?: readonly string[];
	readonly configuredCodexHarnessAuthAgentIds?: readonly string[];
	readonly codexHarnessAuthReadErrors?: readonly CodexHarnessAuthReadError[];
	readonly config: OpenClawDeploymentConfig;
	readonly configPath?: string | undefined;
	readonly configReadError?: string | undefined;
	readonly runtimeMaterializesPortalEndpoints?: boolean;
	readonly zoneId: OpenClawDeploymentRequirementTarget['zoneId'];
}

function includesString(values: readonly unknown[] | undefined, expectedValue: string): boolean {
	return values?.some((value) => value === expectedValue) === true;
}

function includesAllStrings(
	values: readonly unknown[] | undefined,
	expectedValues: readonly string[],
): boolean {
	return expectedValues.every((expectedValue) => includesString(values, expectedValue));
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
	const runtimeKeys = new Set(['configDir']);
	return Object.keys(config).every((key) => runtimeKeys.has(key));
}

function hasMcpPortalPlugin(config: OpenClawDeploymentConfig): boolean {
	return (
		includesString(config.plugins?.allow, 'mcp-portal') ||
		hasEnabledEntry(config.plugins?.entries, 'mcp-portal')
	);
}

function hasPluginApprovalSessionRoute(config: OpenClawDeploymentConfig): boolean {
	const approvals = config.approvals;
	if (!isObjectRecord(approvals)) {
		return false;
	}
	const pluginApprovals = approvals.plugin;
	if (!isObjectRecord(pluginApprovals)) {
		return false;
	}
	return pluginApprovals.enabled === true && pluginApprovals.mode === 'session';
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

function isOpenAiModel(modelName: string | undefined): boolean {
	return modelName?.startsWith('openai/') === true || modelName === 'openai';
}

function hasOpenAiProviderConfig(config: OpenClawDeploymentConfig): boolean {
	const models = config.models;
	if (!isObjectRecord(models)) {
		return false;
	}
	const providers = models.providers;
	return isObjectRecord(providers) && isObjectRecord(providers.openai);
}

function openAiProviderUsesPiRuntime(config: OpenClawDeploymentConfig): boolean {
	const models = config.models;
	if (!isObjectRecord(models)) {
		return true;
	}
	const providers = models.providers;
	if (!isObjectRecord(providers)) {
		return true;
	}
	const openAiProvider = providers.openai;
	if (!isObjectRecord(openAiProvider)) {
		return true;
	}
	const agentRuntime = openAiProvider.agentRuntime;
	return isObjectRecord(agentRuntime) && agentRuntime.id === 'pi';
}

function collectOpenClawOpenAiAgentIds(config: OpenClawDeploymentConfig): readonly string[] {
	const defaultModelName = resolveOpenClawModelName(config.agents?.defaults?.model);
	return (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.filter((agent) => isOpenAiModel(resolveOpenClawModelName(agent.model) ?? defaultModelName))
		.map((agent) => agent.id)
		.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0);
}

function collectConfiguredAgentIds(config: OpenClawDeploymentConfig): readonly string[] {
	return (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.map((agent) => agent.id)
		.filter((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0);
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

function hasNoOrphanPortalServers(config: OpenClawDeploymentConfig): boolean {
	const servers = readMcpServers(config);
	return Object.keys(servers).every((serverName) => !isPortalServerName(serverName));
}

function hasPortalServers(config: OpenClawDeploymentConfig): boolean {
	return Object.keys(readMcpServers(config)).some(isPortalServerName);
}

function hasValidPortalEndpointConfiguration(props: {
	readonly config: OpenClawDeploymentConfig;
	readonly configuredAgentIds: readonly string[];
	readonly runtimeMaterializesPortalEndpoints: boolean;
}): boolean {
	if (props.configuredAgentIds.length === 0) {
		return false;
	}
	return props.runtimeMaterializesPortalEndpoints && hasNoOrphanPortalServers(props.config);
}

function buildPortalEndpointConfigurationHint(props: {
	readonly configuredAgentIds: readonly string[];
	readonly runtimeMaterializesPortalEndpoints: boolean;
}): string {
	if (props.configuredAgentIds.length === 0) {
		return 'No agents are configured for this OpenClaw zone. Add at least one agent under zones[].agents and openclaw.json agents.list before MCP Portal endpoint readiness can pass.';
	}
	return props.runtimeMaterializesPortalEndpoints
		? 'agent-vm registers native MCP Portal tools through the OpenClaw plugin; do not configure mcp.servers portal endpoints.'
		: 'Set zones[].mcpPortal.configDir so agent-vm registers native MCP Portal tools through the OpenClaw plugin.';
}

function buildAgentAuthProfileChecks(
	target: OpenClawDeploymentDoctorTarget,
): readonly DoctorCheck[] {
	const configuredAuthProfileAgentIds = new Set(target.configuredAuthProfileAgentIds ?? []);
	const configuredCodexHarnessAuthAgentIds = new Set(
		target.configuredCodexHarnessAuthAgentIds ?? [],
	);
	return collectOpenClawOpenAiAgentIds(target.config).map((agentId) => {
		const hasAuthProfile = configuredAuthProfileAgentIds.has(agentId);
		const hasCodexHarnessAuth = configuredCodexHarnessAuthAgentIds.has(agentId);
		const hasAuthMaterial = hasAuthProfile || hasCodexHarnessAuth;
		return {
			name: `openclaw-agent-auth-profile-${target.zoneId}-${agentId}`,
			ok: hasAuthMaterial,
			hint: hasAuthProfile
				? `OpenClaw auth profile configured for agent ${agentId}`
				: hasCodexHarnessAuth
					? `OpenAI OAuth auth.json present for agent ${agentId}`
					: `Run agent-vm auth codex-harness --zone ${target.zoneId} --agent ${agentId} or configure gateway.authProfilesByAgent.${agentId}.`,
		} satisfies DoctorCheck;
	});
}

function buildCodexHarnessAuthReadErrorChecks(
	target: OpenClawDeploymentDoctorTarget,
): readonly DoctorCheck[] {
	return (target.codexHarnessAuthReadErrors ?? []).map(
		(readError) =>
			({
				name: `openclaw-codex-harness-auth-readable-${target.zoneId}-${readError.agentId}`,
				ok: false,
				hint: `Cannot read OpenAI OAuth auth.json at ${readError.path}: ${readError.message}`,
			}) satisfies DoctorCheck,
	);
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
		const pluginLoadPaths = config.plugins?.load?.paths;
		const hasMemoryCore =
			includesString(config.plugins?.allow, 'memory-core') ||
			hasEnabledEntry(config.plugins?.entries, 'memory-core');
		const configuredAgentIds = collectConfiguredAgentIds(config);
		const shouldCheckMcpPortal =
			target.runtimeMaterializesPortalEndpoints === true ||
			hasMcpPortalPlugin(config) ||
			hasPortalServers(config);
		const mcpPortalChecks = shouldCheckMcpPortal
			? [
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
						hint: 'Move MCP Portal namespace/tool policy to mcp-portal.config.jsonc; OpenClaw plugin config may only carry configDir.',
					},
					{
						name: `openclaw-mcp-portal-plugin-approvals-${target.zoneId}`,
						ok: hasPluginApprovalSessionRoute(config),
						hint: 'Set approvals.plugin.enabled=true and approvals.plugin.mode="session" so MCP Portal tools that require approval can return prompts to the originating chat.',
					},
					{
						name: `openclaw-mcp-portal-agent-endpoints-${target.zoneId}`,
						ok: hasValidPortalEndpointConfiguration({
							config,
							configuredAgentIds,
							runtimeMaterializesPortalEndpoints:
								target.runtimeMaterializesPortalEndpoints === true,
						}),
						hint: buildPortalEndpointConfigurationHint({
							configuredAgentIds,
							runtimeMaterializesPortalEndpoints:
								target.runtimeMaterializesPortalEndpoints === true,
						}),
					},
				]
			: [];
		return [
			...requirementChecks,
			{
				name: `openclaw-plugin-load-paths-${target.zoneId}`,
				ok: includesAllStrings(pluginLoadPaths, [
					openClawGondolinPluginLoadPath,
					openClawManagedPackageLoadPath,
				]),
				hint: `Add plugins.load.paths for ${openClawGondolinPluginLoadPath} and ${openClawManagedPackageLoadPath}.`,
			},
			...mcpPortalChecks,
			{
				name: `openclaw-memory-slot-${target.zoneId}`,
				ok: !hasMemoryCore || config.plugins?.slots?.memory === 'memory-core',
				hint:
					!hasMemoryCore || config.plugins?.slots?.memory === 'memory-core'
						? 'plugins.slots.memory=memory-core'
						: 'Set plugins.slots.memory to "memory-core" when memory-core is enabled.',
			},
			{
				name: `openclaw-openai-provider-runtime-${target.zoneId}`,
				ok: openAiProviderUsesPiRuntime(config),
				hint: hasOpenAiProviderConfig(config)
					? 'Set models.providers.openai.agentRuntime.id="pi" so OpenAI provider requests use the PI runtime.'
					: 'No models.providers.openai config present.',
			},
			...buildCodexHarnessAuthReadErrorChecks(target),
			...buildAgentAuthProfileChecks(target),
		] as const satisfies readonly DoctorCheck[];
	});
}

function isOpenClawSystemZone(
	zone: LoadedSystemConfig['zones'][number],
): zone is OpenClawSystemZone {
	return zone.gateway.type === 'openclaw';
}

async function collectCodexHarnessAuthAgentIds(
	zone: OpenClawSystemZone,
	config: OpenClawDeploymentConfig,
): Promise<CodexHarnessAuthScan> {
	const agentIds: string[] = [];
	const readErrors: CodexHarnessAuthReadError[] = [];
	for (const agentId of collectOpenClawOpenAiAgentIds(config)) {
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
		} catch (error) {
			const errorCode =
				isObjectRecord(error) && typeof error.code === 'string' ? error.code : undefined;
			if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
				// Missing auth.json is reported by buildAgentAuthProfileChecks.
				continue;
			}
			readErrors.push({
				agentId,
				message: error instanceof Error ? error.message : String(error),
				path: authJsonPath,
			});
		}
	}
	return { agentIds, readErrors };
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
	const targets = await collectOpenClawDeploymentRequirementTargets(systemConfig);
	const doctorTargets = await Promise.all(
		targets.map(async (target): Promise<OpenClawDeploymentDoctorTarget> => {
			const zone = openClawZones.find((candidate) => candidate.id === target.zoneId);
			const codexHarnessAuthScan =
				target.kind === 'readable' && zone
					? await collectCodexHarnessAuthAgentIds(zone, target.config)
					: { agentIds: [], readErrors: [] };
			const baseTarget =
				target.kind === 'readable'
					? {
							config: target.config,
							codexHarnessAuthReadErrors: codexHarnessAuthScan.readErrors,
							configuredCodexHarnessAuthAgentIds: codexHarnessAuthScan.agentIds,
							configuredAuthProfileAgentIds:
								configuredAuthProfileAgentIdsByZone.get(target.zoneId) ?? [],
							configPath: target.configPath,
							runtimeMaterializesPortalEndpoints: zone?.mcpPortal !== undefined,
							zoneId: target.zoneId,
						}
					: {
							config: {},
							codexHarnessAuthReadErrors: codexHarnessAuthScan.readErrors,
							configuredCodexHarnessAuthAgentIds: codexHarnessAuthScan.agentIds,
							configuredAuthProfileAgentIds:
								configuredAuthProfileAgentIdsByZone.get(target.zoneId) ?? [],
							configPath: target.configPath,
							configReadError: target.configReadError,
							runtimeMaterializesPortalEndpoints: zone?.mcpPortal !== undefined,
							zoneId: target.zoneId,
						};
			return baseTarget;
		}),
	);
	return buildOpenClawDeploymentDoctorChecks(doctorTargets);
}
