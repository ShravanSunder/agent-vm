import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	isRuntimeConfigReference,
	isRuntimeSystemConfigPath,
	runtimeConfigRoot,
} from './runtime-config-paths.js';

type OpenClawSystemZone = LoadedSystemConfig['zones'][number] & {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'openclaw' }
	>;
};

export interface OpenClawDeploymentConfig {
	readonly [key: string]: unknown;
	readonly agents?: {
		readonly defaults?: OpenClawAgentConfig;
		readonly list?: readonly unknown[];
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

interface OpenClawAgentConfig {
	readonly [key: string]: unknown;
	readonly id?: unknown;
	readonly model?: unknown;
	readonly sandbox?: {
		readonly [key: string]: unknown;
		readonly backend?: unknown;
		readonly mode?: unknown;
		readonly scope?: unknown;
		readonly workspaceAccess?: unknown;
	};
	readonly workspace?: unknown;
}

export type OpenClawDeploymentRequirementTarget =
	| {
			readonly config: OpenClawDeploymentConfig;
			readonly configPath?: string | undefined;
			readonly kind: 'readable';
			readonly zoneId: string;
	  }
	| {
			readonly configPath?: string | undefined;
			readonly configReadError: string;
			readonly kind: 'unreadable';
			readonly zoneId: string;
	  };

export interface OpenClawDeploymentRequirementFinding {
	readonly hint: string;
	readonly id: string;
	readonly ok: boolean;
}

export class OpenClawDeploymentRequirementError extends Error {
	readonly failedFindings: readonly OpenClawDeploymentRequirementFinding[];
	readonly kind = 'openclaw-tool-vm-requirements-failed';
	readonly zoneId: string;

	constructor(zoneId: string, failedFindings: readonly OpenClawDeploymentRequirementFinding[]) {
		super(formatOpenClawDeploymentRequirementFailureMessage(zoneId, failedFindings));
		this.name = 'OpenClawDeploymentRequirementError';
		this.zoneId = zoneId;
		this.failedFindings = failedFindings;
	}
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOpenClawDeploymentConfig(rawConfig: string): OpenClawDeploymentConfig {
	const parsedConfig: unknown = JSON.parse(rawConfig);
	return isObjectRecord(parsedConfig) ? parsedConfig : {};
}

function projectRootForSystemConfig(systemConfig: LoadedSystemConfig): string {
	return path.resolve(path.dirname(systemConfig.systemConfigPath), '..');
}

export function resolveOpenClawDeploymentConfigPath(
	systemConfig: LoadedSystemConfig,
	configuredPath: string,
): string {
	if (isRuntimeSystemConfigPath(systemConfig)) {
		return configuredPath;
	}
	if (!isRuntimeConfigReference(configuredPath)) {
		return configuredPath;
	}

	const relativeRuntimePath = path.relative(runtimeConfigRoot, configuredPath);
	const projectRoot = projectRootForSystemConfig(systemConfig);
	if (relativeRuntimePath === 'system.json') {
		return path.join(projectRoot, 'config', 'system.json');
	}
	if (relativeRuntimePath.startsWith(`gateways${path.sep}`) || relativeRuntimePath === 'gateways') {
		return path.join(projectRoot, 'config', relativeRuntimePath);
	}
	return path.join(projectRoot, relativeRuntimePath);
}

function isOpenClawSystemZone(
	zone: LoadedSystemConfig['zones'][number],
): zone is OpenClawSystemZone {
	return zone.gateway.type === 'openclaw';
}

function readAgentConfigEntries(config: OpenClawDeploymentConfig): readonly {
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
}): OpenClawDeploymentRequirementFinding {
	const ok = options.actualValue === options.expectedValue;
	return {
		id: `openclaw-tool-vm-${options.fieldPath.replace(/[.[\]]/gu, '-')}-${options.zoneId}-${options.label}`,
		ok,
		hint: ok
			? `${options.fieldPath}=${options.expectedValue}`
			: `Set ${options.fieldPath} to "${options.expectedValue}" for OpenClaw Tool VM mediation.`,
	};
}

export function evaluateOpenClawDeploymentRequirements(
	target: OpenClawDeploymentRequirementTarget,
): readonly OpenClawDeploymentRequirementFinding[] {
	if (target.kind === 'unreadable') {
		return [
			{
				id: `openclaw-deployment-config-readable-${target.zoneId}`,
				ok: false,
				hint: `Cannot read ${target.configPath ?? 'OpenClaw config'}: ${target.configReadError}`,
			},
		];
	}

	const defaults = target.config.agents?.defaults ?? {};
	const readableFinding =
		target.configPath === undefined
			? []
			: [
					{
						id: `openclaw-deployment-config-readable-${target.zoneId}`,
						ok: true,
						hint: target.configPath,
					} satisfies OpenClawDeploymentRequirementFinding,
				];
	return [
		...readableFinding,
		...readAgentConfigEntries(target.config).flatMap(({ config, label }) => {
			const workspace = effectiveWorkspace(defaults, config);
			return [
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, config, 'backend'),
					expectedValue: 'gondolin',
					fieldPath: `agents.${label}.sandbox.backend`,
					label,
					zoneId: target.zoneId,
				}),
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, config, 'mode'),
					expectedValue: 'all',
					fieldPath: `agents.${label}.sandbox.mode`,
					label,
					zoneId: target.zoneId,
				}),
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, config, 'scope'),
					expectedValue: 'agent',
					fieldPath: `agents.${label}.sandbox.scope`,
					label,
					zoneId: target.zoneId,
				}),
				requirementFinding({
					actualValue: effectiveSandboxValue(defaults, config, 'workspaceAccess'),
					expectedValue: 'rw',
					fieldPath: `agents.${label}.sandbox.workspaceAccess`,
					label,
					zoneId: target.zoneId,
				}),
				{
					id: `openclaw-tool-vm-workspace-${target.zoneId}-${label}`,
					ok: workspace !== '/zone',
					hint:
						workspace === '/zone'
							? 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.'
							: typeof workspace === 'string'
								? workspace
								: 'agents workspace is unset',
				},
			] as const satisfies readonly OpenClawDeploymentRequirementFinding[];
		}),
	];
}

export async function collectOpenClawDeploymentRequirementTargets(
	systemConfig: LoadedSystemConfig,
): Promise<readonly OpenClawDeploymentRequirementTarget[]> {
	return await Promise.all(
		systemConfig.zones.filter(isOpenClawSystemZone).map(async (zone) => {
			const configPath = resolveOpenClawDeploymentConfigPath(systemConfig, zone.gateway.config);
			try {
				const rawConfig = await readFile(configPath, 'utf8');
				return {
					zoneId: zone.id,
					configPath,
					config: parseOpenClawDeploymentConfig(rawConfig),
					kind: 'readable',
				} satisfies OpenClawDeploymentRequirementTarget;
			} catch (error) {
				return {
					zoneId: zone.id,
					configPath,
					configReadError: error instanceof Error ? error.message : String(error),
					kind: 'unreadable',
				} satisfies OpenClawDeploymentRequirementTarget;
			}
		}),
	);
}

export async function collectOpenClawDeploymentRequirementFindings(
	systemConfig: LoadedSystemConfig,
): Promise<readonly OpenClawDeploymentRequirementFinding[]> {
	const targets = await collectOpenClawDeploymentRequirementTargets(systemConfig);
	return targets.flatMap((target) => evaluateOpenClawDeploymentRequirements(target));
}

export function formatOpenClawDeploymentRequirementFailureMessage(
	zoneId: string,
	failedFindings: readonly OpenClawDeploymentRequirementFinding[],
): string {
	return `OpenClaw zone '${zoneId}' Tool VM requirements failed: ${failedFindings.map((finding) => `${finding.id}: ${finding.hint}`).join('; ')}`;
}

export async function assertOpenClawToolVmRequirements(
	systemConfig: LoadedSystemConfig,
	zoneId: string,
): Promise<void> {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
	if (!zone || zone.gateway.type !== 'openclaw') {
		return;
	}

	const failedFindings = (
		await collectOpenClawDeploymentRequirementFindings({
			...systemConfig,
			zones: [zone],
		})
	).filter((finding) => !finding.ok);
	if (failedFindings.length > 0) {
		throw new OpenClawDeploymentRequirementError(zoneId, failedFindings);
	}
}
