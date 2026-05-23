import {
	effectiveOpenClawGondolinSandboxValue,
	formatOpenClawGondolinRequirementFieldPath,
	formatOpenClawGondolinRequirementFindingId,
	formatOpenClawGondolinRequirementHint,
	OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS,
	type OpenClawGondolinAgentConfig,
} from './openclaw-gondolin-contract.js';

interface OpenClawRuntimeConfig {
	readonly [key: string]: unknown;
	readonly agents?: {
		readonly defaults?: OpenClawGondolinAgentConfig;
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
	readonly config: OpenClawGondolinAgentConfig;
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

function effectiveWorkspace(
	defaults: OpenClawGondolinAgentConfig,
	agentConfig: OpenClawGondolinAgentConfig,
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
		id: formatOpenClawGondolinRequirementFindingId({
			fieldPath: options.fieldPath,
			label: options.label,
			zoneId: options.zoneId,
		}),
		ok,
		hint: formatOpenClawGondolinRequirementHint({
			expectedValue: options.expectedValue,
			fieldPath: options.fieldPath,
			ok,
		}),
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
			const requirementFindings = OPENCLAW_GONDOLIN_SANDBOX_REQUIREMENTS.map((requirement) =>
				requirementFinding({
					actualValue: effectiveOpenClawGondolinSandboxValue(
						defaults,
						agentConfig,
						requirement.key,
					),
					expectedValue: requirement.expectedValue,
					fieldPath: formatOpenClawGondolinRequirementFieldPath(label, requirement.key),
					label,
					zoneId: options.zoneId,
				}),
			);
			const workspaceFinding = {
				id: `openclaw-tool-vm-workspace-${options.zoneId}-${label}`,
				ok: workspace !== '/zone',
				hint:
					workspace === '/zone'
						? 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.'
						: typeof workspace === 'string'
							? workspace
							: 'agents workspace is unset',
			} satisfies OpenClawRuntimeRequirementFinding;
			return requirementFindings.concat(workspaceFinding);
		}),
	};
}
