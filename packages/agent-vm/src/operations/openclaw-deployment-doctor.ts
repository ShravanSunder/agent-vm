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

type OpenClawAuthTargetKind = 'codex-harness' | 'openclaw-provider';

interface OpenClawAuthTarget {
	readonly agentId?: string;
	readonly kind: OpenClawAuthTargetKind;
	readonly provider: string;
	readonly targetId: string;
}

const openClawGondolinPluginLoadPath = '/home/openclaw/.openclaw/extensions/gondolin';
const openClawDeprecatedMcpPortalPluginLoadPath = '/home/openclaw/.openclaw/extensions/mcp-portal';
const openClawManagedPackageLoadPath = '/pnpm/global/5/node_modules/@openclaw';

export interface OpenClawDeploymentDoctorTarget {
	readonly configuredAuthLoginDefaultAgentId?: string | undefined;
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

function hasDeprecatedMcpPortalPlugin(config: OpenClawDeploymentConfig): boolean {
	return (
		includesString(config.plugins?.allow, 'mcp-portal') ||
		hasEnabledEntry(config.plugins?.entries, 'mcp-portal')
	);
}

function hasDeprecatedMcpPortalPluginIdentity(config: OpenClawDeploymentConfig): boolean {
	return (
		hasDeprecatedMcpPortalPlugin(config) ||
		includesString(config.plugins?.load?.paths, openClawDeprecatedMcpPortalPluginLoadPath)
	);
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

function isOpenAiProviderModel(modelName: string | undefined): modelName is `openai/${string}` {
	return modelName?.startsWith('openai/') === true;
}

function readModelRuntimeId(
	config: OpenClawDeploymentConfig,
	agent: Record<string, unknown>,
	modelName: string,
): string | undefined {
	const agentModels = agent.models;
	const defaultModels = config.agents?.defaults?.models;
	for (const models of [agentModels, defaultModels]) {
		if (!isObjectRecord(models)) {
			continue;
		}
		const modelConfig = models[modelName];
		if (!isObjectRecord(modelConfig)) {
			continue;
		}
		const agentRuntime = modelConfig.agentRuntime;
		if (isObjectRecord(agentRuntime) && typeof agentRuntime.id === 'string') {
			return agentRuntime.id;
		}
	}
	return undefined;
}

function readProviderRuntimeId(
	config: OpenClawDeploymentConfig,
	providerName: string,
): string | undefined {
	const models = config.models;
	if (!isObjectRecord(models)) {
		return undefined;
	}
	const providers = models.providers;
	if (!isObjectRecord(providers)) {
		return undefined;
	}
	const provider = providers[providerName];
	if (!isObjectRecord(provider)) {
		return undefined;
	}
	const agentRuntime = provider.agentRuntime;
	return isObjectRecord(agentRuntime) && typeof agentRuntime.id === 'string'
		? agentRuntime.id
		: undefined;
}

function isOpenClawRuntimeId(runtimeId: string | undefined): boolean {
	return runtimeId === 'openclaw' || runtimeId === 'pi';
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
	const modelNames = collectConfiguredOpenAiModelNames(config);
	if (modelNames.length > 0) {
		return modelNames.every((modelName) =>
			isOpenClawRuntimeId(
				readModelRuntimeId(config, {}, modelName) ?? readProviderRuntimeId(config, 'openai'),
			),
		);
	}
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
	return (
		isObjectRecord(agentRuntime) &&
		typeof agentRuntime.id === 'string' &&
		isOpenClawRuntimeId(agentRuntime.id)
	);
}

function collectOpenClawCodexAgentIds(config: OpenClawDeploymentConfig): readonly string[] {
	return collectOpenClawAuthTargets(config).flatMap((target) =>
		target.kind === 'codex-harness' && target.agentId !== undefined ? [target.agentId] : [],
	);
}

function collectOpenClawAuthTargets(
	config: OpenClawDeploymentConfig,
): readonly OpenClawAuthTarget[] {
	const defaultModelName = resolveOpenClawModelName(config.agents?.defaults?.model);
	const agentTargets = (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.map((agent): OpenClawAuthTarget | undefined => {
			if (typeof agent.id !== 'string' || agent.id.length === 0) {
				return undefined;
			}
			const modelName = resolveOpenClawModelName(agent.model) ?? defaultModelName;
			if (isOpenAiCodexModel(modelName)) {
				return {
					agentId: agent.id,
					kind: 'codex-harness',
					provider: 'openai',
					targetId: agent.id,
				};
			}
			if (
				isOpenAiProviderModel(modelName) &&
				isOpenClawRuntimeId(
					readModelRuntimeId(config, agent, modelName) ?? readProviderRuntimeId(config, 'openai'),
				)
			) {
				return {
					agentId: agent.id,
					kind: 'openclaw-provider',
					provider: 'openai',
					targetId: agent.id,
				};
			}
			return undefined;
		})
		.filter((target): target is OpenClawAuthTarget => target !== undefined);
	if (agentTargets.length > 0) {
		return agentTargets;
	}
	if (
		isOpenAiProviderModel(defaultModelName) &&
		isOpenClawRuntimeId(
			readModelRuntimeId(config, {}, defaultModelName) ?? readProviderRuntimeId(config, 'openai'),
		)
	) {
		return [{ kind: 'openclaw-provider', provider: 'openai', targetId: 'default' }];
	}
	return [];
}

function collapseOpenClawProviderAuthTargetsToDefaultAgent(props: {
	readonly authTargets: readonly OpenClawAuthTarget[];
	readonly defaultAgentId: string | undefined;
}): readonly OpenClawAuthTarget[] {
	if (props.defaultAgentId === undefined) {
		return props.authTargets;
	}
	const providerTargets = props.authTargets.filter(
		(authTarget) => authTarget.kind === 'openclaw-provider',
	);
	if (providerTargets.length === 0) {
		return props.authTargets;
	}
	const codexHarnessTargets = props.authTargets.filter(
		(authTarget) => authTarget.kind === 'codex-harness',
	);
	const collapsedProviderTargets = new Map<string, OpenClawAuthTarget>();
	for (const authTarget of providerTargets) {
		collapsedProviderTargets.set(authTarget.provider, {
			agentId: props.defaultAgentId,
			kind: 'openclaw-provider',
			provider: authTarget.provider,
			targetId: props.defaultAgentId,
		});
	}
	return [...codexHarnessTargets, ...collapsedProviderTargets.values()];
}

function collectConfiguredOpenAiModelNames(config: OpenClawDeploymentConfig): readonly string[] {
	const modelNames = new Set<string>();
	const defaultModelName = resolveOpenClawModelName(config.agents?.defaults?.model);
	if (isOpenAiProviderModel(defaultModelName)) {
		modelNames.add(defaultModelName);
	}
	for (const agent of config.agents?.list ?? []) {
		if (!isObjectRecord(agent)) {
			continue;
		}
		const modelName = resolveOpenClawModelName(agent.model) ?? defaultModelName;
		if (isOpenAiProviderModel(modelName)) {
			modelNames.add(modelName);
		}
	}
	return [...modelNames];
}

function formatOpenAiRuntimeHint(config: OpenClawDeploymentConfig): string {
	const modelName = collectConfiguredOpenAiModelNames(config)[0] ?? 'openai/gpt-5.5';
	return `Set agents.defaults.models["${modelName}"].agentRuntime.id="openclaw" so OpenAI API-key models use the OpenClaw runtime.`;
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
		return 'No agents are configured for this OpenClaw zone. Add at least one agent under zones[].agents and openclaw.json agents.list before Tool Portal native tool readiness can pass.';
	}
	return props.runtimeMaterializesPortalEndpoints
		? 'agent-vm registers Tool Portal native tools through the Gondolin OpenClaw plugin; do not configure mcp.servers portal endpoints.'
		: 'Set zones[].toolPortal.configDir so agent-vm materializes Tool Portal native tools through the Gondolin OpenClaw plugin.';
}

function buildAgentAuthProfileChecks(
	target: OpenClawDeploymentDoctorTarget,
): readonly DoctorCheck[] {
	const configuredAuthProfileAgentIds = new Set(target.configuredAuthProfileAgentIds ?? []);
	const configuredCodexHarnessAuthAgentIds = new Set(
		target.configuredCodexHarnessAuthAgentIds ?? [],
	);
	const authTargets = collapseOpenClawProviderAuthTargetsToDefaultAgent({
		authTargets: collectOpenClawAuthTargets(target.config),
		defaultAgentId: target.configuredAuthLoginDefaultAgentId,
	});
	return authTargets.map((authTarget) => {
		const hasAuthProfile =
			authTarget.agentId !== undefined && configuredAuthProfileAgentIds.has(authTarget.agentId);
		const hasCodexHarnessAuth =
			authTarget.agentId !== undefined &&
			configuredCodexHarnessAuthAgentIds.has(authTarget.agentId);
		const hasAuthMaterial =
			hasAuthProfile || (authTarget.kind === 'codex-harness' && hasCodexHarnessAuth);
		return {
			name: `openclaw-agent-auth-profile-${target.zoneId}-${authTarget.targetId}`,
			ok: hasAuthMaterial,
			hint: hasAuthProfile
				? `OpenClaw auth profile configured for agent ${authTarget.agentId}`
				: authTarget.kind === 'codex-harness' && hasCodexHarnessAuth
					? `Codex harness auth.json present for agent ${authTarget.agentId}`
					: authTarget.kind === 'openclaw-provider'
						? authTarget.agentId === undefined
							? `Run agent-vm auth openclaw login ${authTarget.provider} --zone ${target.zoneId} for the default OpenClaw auth profile.`
							: `Run agent-vm auth openclaw login ${authTarget.provider} --zone ${target.zoneId} --agent ${authTarget.agentId} or configure gateway.authProfilesByAgent.${authTarget.agentId}.`
						: `Run agent-vm auth codex-harness --zone ${target.zoneId} --agent ${authTarget.agentId} or configure gateway.authProfilesByAgent.${authTarget.agentId}.`,
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
				hint: `Cannot read Codex harness auth.json at ${readError.path}: ${readError.message}`,
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
					...(target.runtimeMaterializesPortalEndpoints === undefined
						? {}
						: {
								runtimeMaterializesPortalEndpoints: target.runtimeMaterializesPortalEndpoints,
							}),
					zoneId: target.zoneId,
				}
			: {
					...(target.configPath ? { configPath: target.configPath } : {}),
					configReadError: target.configReadError,
					kind: 'unreadable',
					...(target.runtimeMaterializesPortalEndpoints === undefined
						? {}
						: {
								runtimeMaterializesPortalEndpoints: target.runtimeMaterializesPortalEndpoints,
							}),
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
		const shouldCheckToolPortal =
			target.runtimeMaterializesPortalEndpoints === true ||
			hasDeprecatedMcpPortalPluginIdentity(config) ||
			hasPortalServers(config);
		const toolPortalChecks = shouldCheckToolPortal
			? [
					{
						name: `openclaw-tool-portal-gondolin-plugin-${target.zoneId}`,
						ok:
							includesString(config.plugins?.allow, 'gondolin') &&
							hasEnabledEntry(config.plugins?.entries, 'gondolin'),
						hint: 'Allow and enable the gondolin plugin; Tool Portal native tools are registered by that plugin.',
					},
					{
						name: `openclaw-tool-portal-no-mcp-plugin-${target.zoneId}`,
						ok: !hasDeprecatedMcpPortalPluginIdentity(config),
						hint: 'Remove the old mcp-portal plugin load path, allow entry, and plugin entry; managed OpenClaw exposes tool_portal_* through gondolin.',
					},
					{
						name: `openclaw-tool-portal-agent-endpoints-${target.zoneId}`,
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
			...toolPortalChecks,
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
					? formatOpenAiRuntimeHint(config)
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
							configuredAuthLoginDefaultAgentId: zone?.gateway.authLogin?.defaultAgent,
							configuredCodexHarnessAuthAgentIds: codexHarnessAuthScan.agentIds,
							configuredAuthProfileAgentIds:
								configuredAuthProfileAgentIdsByZone.get(target.zoneId) ?? [],
							configPath: target.configPath,
							runtimeMaterializesPortalEndpoints: zone?.toolPortal !== undefined,
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
							runtimeMaterializesPortalEndpoints: zone?.toolPortal !== undefined,
							zoneId: target.zoneId,
						};
			return baseTarget;
		}),
	);
	return buildOpenClawDeploymentDoctorChecks(doctorTargets);
}
