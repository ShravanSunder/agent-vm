import type { LoadedSystemConfig } from '../config/system-config.js';
import type { DoctorCheck } from './doctor.js';
import {
	collectOpenClawDeploymentRequirementTargets,
	evaluateOpenClawDeploymentRequirements,
	isObjectRecord,
	type OpenClawDeploymentConfig,
	type OpenClawDeploymentRequirementTarget,
} from './openclaw-deployment-requirements.js';

export interface OpenClawDeploymentDoctorTarget {
	readonly configuredAuthProfileAgentIds?: readonly string[];
	readonly config: OpenClawDeploymentRequirementTarget['config'];
	readonly configPath?: string | undefined;
	readonly configReadError?: string | undefined;
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

export function buildOpenClawDeploymentDoctorChecks(
	targets: readonly OpenClawDeploymentDoctorTarget[],
): readonly DoctorCheck[] {
	return targets.flatMap((target) => {
		const config = target.config;
		const pluginLoadPaths = config.plugins?.load?.paths;
		const hasMemoryCore =
			includesString(config.plugins?.allow, 'memory-core') ||
			hasEnabledEntry(config.plugins?.entries, 'memory-core');
		const requirementChecks = evaluateOpenClawDeploymentRequirements(target).map(
			(finding) =>
				({
					name: finding.id,
					ok: finding.ok,
					hint: finding.hint,
				}) satisfies DoctorCheck,
		);
		return [
			...requirementChecks,
			{
				name: `openclaw-plugin-load-paths-${target.zoneId}`,
				ok:
					includesString(pluginLoadPaths, '/home/openclaw/.openclaw/extensions') &&
					includesString(pluginLoadPaths, '/pnpm/global/5/node_modules/@openclaw'),
				hint: 'Add plugins.load.paths for /home/openclaw/.openclaw/extensions and /pnpm/global/5/node_modules/@openclaw.',
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

export async function collectOpenClawDeploymentDoctorChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly DoctorCheck[]> {
	const configuredAuthProfileAgentIdsByZone = new Map(
		systemConfig.zones
			.filter(
				(
					zone,
				): zone is LoadedSystemConfig['zones'][number] & {
					readonly gateway: Extract<
						LoadedSystemConfig['zones'][number]['gateway'],
						{ readonly type: 'openclaw' }
					>;
				} => zone.gateway.type === 'openclaw',
			)
			.map((zone) => [zone.id, Object.keys(zone.gateway.authProfilesByAgent ?? {})] as const),
	);
	const targets = await collectOpenClawDeploymentRequirementTargets(systemConfig);
	const doctorTargets: OpenClawDeploymentDoctorTarget[] = [];
	for (const target of targets) {
		doctorTargets.push({
			config: target.config,
			configuredAuthProfileAgentIds: configuredAuthProfileAgentIdsByZone.get(target.zoneId) ?? [],
			configPath: target.configPath,
			configReadError: target.configReadError,
			zoneId: target.zoneId,
		});
	}
	return buildOpenClawDeploymentDoctorChecks(doctorTargets);
}
