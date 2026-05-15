interface OpenClawAgentConfig {
	readonly [key: string]: unknown;
	readonly id?: unknown;
	readonly sandbox?: {
		readonly [key: string]: unknown;
		readonly backend?: unknown;
		readonly mode?: unknown;
		readonly scope?: unknown;
		readonly workspaceAccess?: unknown;
	};
	readonly workspace?: unknown;
}

interface OpenClawRuntimeConfig {
	readonly [key: string]: unknown;
	readonly agents?: {
		readonly defaults?: OpenClawAgentConfig;
		readonly list?: readonly unknown[];
	};
}

export interface OpenClawRuntimeRequirementFinding {
	readonly hint: string;
	readonly id: string;
	readonly ok: boolean;
}

export interface OpenClawRuntimeStatusReport {
	readonly findings: readonly OpenClawRuntimeRequirementFinding[];
	readonly pluginId: 'gondolin';
	readonly zoneId: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAgentConfigEntries(config: OpenClawRuntimeConfig): readonly {
	readonly config: OpenClawAgentConfig;
	readonly label: string;
}[] {
	const defaultConfig = config.agents?.defaults ?? {};
	const agentConfigs = (config.agents?.list ?? [])
		.filter(isObjectRecord)
		.map((agentConfig, agentIndex) => ({
			config: agentConfig,
			label:
				typeof agentConfig.id === 'string'
					? `agent-${agentConfig.id}`
					: `agent-${String(agentIndex)}`,
		}));
	return [{ config: defaultConfig, label: 'defaults' }, ...agentConfigs];
}

function effectiveSandboxValue(
	defaults: OpenClawAgentConfig,
	agentConfig: OpenClawAgentConfig,
	key: 'backend' | 'mode' | 'scope' | 'workspaceAccess',
): unknown {
	return agentConfig.sandbox?.[key] ?? defaults.sandbox?.[key];
}

function effectiveWorkspace(
	defaults: OpenClawAgentConfig,
	agentConfig: OpenClawAgentConfig,
): unknown {
	return agentConfig.workspace ?? defaults.workspace;
}

function requirementFinding(options: {
	readonly actualValue: unknown;
	readonly expectedValue: string;
	readonly fieldPath: string;
	readonly label: string;
	readonly zoneId: string;
}): OpenClawRuntimeRequirementFinding {
	const ok = options.actualValue === options.expectedValue;
	return {
		id: `openclaw-tool-vm-${options.fieldPath.replace(/[.[\]]/gu, '-')}-${options.zoneId}-${options.label}`,
		ok,
		hint: ok
			? `${options.fieldPath}=${options.expectedValue}`
			: `Set ${options.fieldPath} to "${options.expectedValue}" for OpenClaw Tool VM mediation.`,
	};
}

export function buildOpenClawRuntimeStatusReport(options: {
	readonly config: Record<string, unknown>;
	readonly zoneId: string;
}): OpenClawRuntimeStatusReport {
	const config: OpenClawRuntimeConfig = options.config;
	const defaults = config.agents?.defaults ?? {};
	return {
		pluginId: 'gondolin',
		zoneId: options.zoneId,
		findings: readAgentConfigEntries(config).flatMap(({ config: agentConfig, label }) => {
			const workspace = effectiveWorkspace(defaults, agentConfig);
			return [
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, agentConfig, 'backend'),
					expectedValue: 'gondolin',
					fieldPath: `agents.${label}.sandbox.backend`,
					label,
					zoneId: options.zoneId,
				}),
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, agentConfig, 'mode'),
					expectedValue: 'all',
					fieldPath: `agents.${label}.sandbox.mode`,
					label,
					zoneId: options.zoneId,
				}),
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, agentConfig, 'scope'),
					expectedValue: 'agent',
					fieldPath: `agents.${label}.sandbox.scope`,
					label,
					zoneId: options.zoneId,
				}),
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, agentConfig, 'workspaceAccess'),
					expectedValue: 'rw',
					fieldPath: `agents.${label}.sandbox.workspaceAccess`,
					label,
					zoneId: options.zoneId,
				}),
				{
					id: `openclaw-tool-vm-workspace-${options.zoneId}-${label}`,
					ok: workspace !== '/zone',
					hint:
						workspace === '/zone'
							? 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.'
							: typeof workspace === 'string'
								? workspace
								: 'agents workspace is unset',
				},
			] as const satisfies readonly OpenClawRuntimeRequirementFinding[];
		}),
	};
}
