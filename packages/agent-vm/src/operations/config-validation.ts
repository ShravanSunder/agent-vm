import { access } from 'node:fs/promises';
import path from 'node:path';

import { loadWorkerConfigDraft } from '@agent-vm/agent-vm-worker';
import {
	loadMcpConfig,
	loadMcpPortalConfig,
	resolveMcpPortalProfile,
} from '@agent-vm/config-contracts';
import type { SecretResolver } from '@agent-vm/secret-management';
import { execa } from 'execa';

import { validateManagedImageOverlay } from '../build/managed-image-dockerfile.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { planMcpPortalEffectiveConfig } from '../gateway/mcp-portal-effective-config.js';
import { buildOpenClawAgentSecretAccessChecks } from './agent-secret-access-checks.js';
import {
	type ConfigValidationCheck,
	type ConfigValidationCommandOptions,
	type ConfigValidationCommandResult,
	type ConfigValidationCommandRunner,
	type ConfigValidationResult,
	projectRootForSystemConfig,
	resolveProjectCheckoutPath,
} from './config-validation-shared.js';
import { buildRuntimePathIsolationChecks, collectVmHostSystemDoctorCheck } from './doctor.js';
import { runLiveMcpPortalValidation } from './mcp-portal-live-validation.js';
import { collectOpenClawDeploymentRequirementFindings } from './openclaw-deployment-requirements.js';

export {
	type ConfigValidationCheck,
	type ConfigValidationCommandOptions,
	type ConfigValidationCommandResult,
	type ConfigValidationCommandRunner,
	type ConfigValidationResult,
	resolveProjectCheckoutPath,
};

export interface RunConfigValidationOptions {
	readonly mcpLive?: boolean;
	readonly runCommand?: ConfigValidationCommandRunner;
	readonly runLiveMcpPortalValidation?: typeof runLiveMcpPortalValidation;
	readonly secretResolver?: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isBlockingValidationCheck(check: ConfigValidationCheck): boolean {
	return !check.ok && check.status !== 'unavailable';
}

const validationOnlySecretResolver = {
	resolve: async (): Promise<string> => '',
	resolveAll: async (): Promise<Record<string, string>> => ({}),
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runCommandDefault(
	command: string,
	arguments_: readonly string[],
	options?: ConfigValidationCommandOptions,
): Promise<ConfigValidationCommandResult> {
	const execaOptions = {
		...(options?.cwd ? { cwd: options.cwd } : {}),
		...(options?.env ? { env: options.env } : {}),
		...(options?.cwd ? { localDir: options.cwd, preferLocal: true } : {}),
		reject: false,
	} as const;
	const result = await execa(command, [...arguments_], execaOptions);
	return {
		exitCode: result.exitCode ?? 1,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

function getErrorCode(error: unknown): string | undefined {
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string'
	) {
		return error.code;
	}
	return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	if (!value.trim()) {
		return null;
	}
	try {
		const parsedValue: unknown = JSON.parse(value);
		if (isObjectRecord(parsedValue)) {
			return parsedValue;
		}
		return null;
	} catch {
		return null;
	}
}

function formatOpenClawIssue(issue: unknown): string | null {
	if (typeof issue === 'string') {
		return issue;
	}
	if (!isObjectRecord(issue)) {
		return null;
	}
	const pathValue = issue.path;
	const messageValue = issue.message;
	const pathText = Array.isArray(pathValue)
		? pathValue.map((part) => String(part)).join('.')
		: typeof pathValue === 'string'
			? pathValue
			: '';
	const messageText = typeof messageValue === 'string' ? messageValue : '';
	if (pathText && messageText) {
		return `${pathText}: ${messageText}`;
	}
	if (messageText) {
		return messageText;
	}
	if (pathText) {
		return pathText;
	}
	return null;
}

function getOpenClawIssuePath(issue: unknown): string {
	if (!isObjectRecord(issue)) {
		return '';
	}
	const pathValue = issue.path;
	if (Array.isArray(pathValue)) {
		return pathValue.map((part) => String(part)).join('.');
	}
	return typeof pathValue === 'string' ? pathValue : '';
}

function getOpenClawIssueMessage(issue: unknown): string {
	if (!isObjectRecord(issue)) {
		return typeof issue === 'string' ? issue : '';
	}
	const messageValue = issue.message;
	return typeof messageValue === 'string' ? messageValue : '';
}

function isHostOnlyOpenClawPluginPathIssue(issue: unknown): boolean {
	return (
		getOpenClawIssuePath(issue) === 'plugins.load.paths' &&
		getOpenClawIssueMessage(issue).includes('plugin path not found')
	);
}

function getOpenClawValidationIssues(parsedOutput: Record<string, unknown>): readonly unknown[] {
	const issueValues = parsedOutput.errors ?? parsedOutput.issues;
	return Array.isArray(issueValues) ? issueValues : [];
}

function summarizeOpenClawValidationIssues(issues: readonly unknown[]): string | null {
	const issueTexts = issues
		.map((issue) => formatOpenClawIssue(issue))
		.filter((issueText): issueText is string => issueText !== null);
	return issueTexts.length > 0 ? issueTexts.join('; ') : null;
}

function summarizeOpenClawValidationOutput(commandResult: ConfigValidationCommandResult): string {
	const parsedOutput =
		parseJsonObject(commandResult.stdout) ?? parseJsonObject(commandResult.stderr);
	if (parsedOutput) {
		const issueText = summarizeOpenClawValidationIssues(getOpenClawValidationIssues(parsedOutput));
		if (issueText) {
			return issueText;
		}
		const messageValue = parsedOutput.message;
		if (typeof messageValue === 'string' && messageValue.length > 0) {
			return messageValue;
		}
	}

	const rawOutput = [commandResult.stderr.trim(), commandResult.stdout.trim()]
		.filter((value) => value.length > 0)
		.join('\n');
	return rawOutput || `OpenClaw config validation exited with ${commandResult.exitCode}.`;
}

function shouldTreatOpenClawValidationResultAsSuccess(
	commandResult: ConfigValidationCommandResult,
): boolean {
	if (commandResult.exitCode === 0) {
		const parsedOutput = parseJsonObject(commandResult.stdout);
		return !parsedOutput || (parsedOutput.ok !== false && parsedOutput.valid !== false);
	}
	const parsedOutput =
		parseJsonObject(commandResult.stdout) ?? parseJsonObject(commandResult.stderr);
	if (!parsedOutput) {
		return false;
	}
	const issues = getOpenClawValidationIssues(parsedOutput);
	return issues.length > 0 && issues.every((issue) => isHostOnlyOpenClawPluginPathIssue(issue));
}

async function collectReadableFileCheck(
	name: string,
	filePath: string,
): Promise<ConfigValidationCheck> {
	try {
		await access(filePath);
		return { name, ok: true, hint: filePath };
	} catch (error) {
		return {
			name,
			ok: false,
			hint: `Missing ${filePath}: ${getErrorMessage(error)}`,
		};
	}
}

async function collectWorkerConfigCheck(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
): Promise<ConfigValidationCheck> {
	const workerConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
	try {
		await loadWorkerConfigDraft(workerConfigPath);
		return {
			name: `worker-config-${zone.id}`,
			ok: true,
			hint: workerConfigPath,
		};
	} catch (error) {
		return {
			name: `worker-config-${zone.id}`,
			ok: false,
			hint: getErrorMessage(error),
		};
	}
}

async function collectGatewayConfigCheck(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
): Promise<ConfigValidationCheck> {
	const gatewayConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
	return await collectReadableFileCheck(`gateway-config-${zone.id}`, gatewayConfigPath);
}

async function collectOpenClawConfigCheck(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
	runCommand: ConfigValidationCommandRunner,
): Promise<ConfigValidationCheck> {
	const gatewayConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
	try {
		const commandResult = await runCommand('openclaw', ['config', 'validate', '--json'], {
			cwd: projectRootForSystemConfig(systemConfig),
			env: { OPENCLAW_CONFIG_PATH: gatewayConfigPath },
		});
		if (shouldTreatOpenClawValidationResultAsSuccess(commandResult)) {
			return {
				name: `openclaw-config-${zone.id}`,
				ok: true,
				hint: gatewayConfigPath,
			};
		}
		return {
			name: `openclaw-config-${zone.id}`,
			ok: false,
			hint: summarizeOpenClawValidationOutput(commandResult),
		};
	} catch (error) {
		const installHint =
			getErrorCode(error) === 'ENOENT'
				? 'OpenClaw CLI not found. Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.6.8.'
				: getErrorMessage(error);
		return {
			name: `openclaw-config-${zone.id}`,
			ok: false,
			hint: installHint,
		};
	}
}

export async function collectOpenClawConfigChecks(
	systemConfig: LoadedSystemConfig,
	runCommand: ConfigValidationCommandRunner = runCommandDefault,
): Promise<readonly ConfigValidationCheck[]> {
	const openClawZones = systemConfig.zones.filter((zone) => zone.gateway.type === 'openclaw');
	return await Promise.all(
		openClawZones.map(
			async (zone) => await collectOpenClawConfigCheck(systemConfig, zone, runCommand),
		),
	);
}

async function collectGatewayImageProfileChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly ConfigValidationCheck[]> {
	const pendingChecks: Promise<ConfigValidationCheck>[] = [];
	for (const [profileName, profile] of Object.entries(systemConfig.imageProfiles.gateways)) {
		const buildConfigPath = resolveProjectCheckoutPath(systemConfig, profile.buildConfig);
		pendingChecks.push(
			collectReadableFileCheck(`gateway-${profileName}-build-config`, buildConfigPath),
		);
		if (profile.source?.kind === 'managedBase' && profile.source.overlay) {
			const overlayPath = resolveProjectCheckoutPath(systemConfig, profile.source.overlay);
			pendingChecks.push(
				collectManagedImageOverlayCheck(`gateway-${profileName}-overlay`, overlayPath),
			);
		}
		if (profile.dockerfile) {
			pendingChecks.push(
				collectReadableFileCheck(
					`gateway-${profileName}-dockerfile`,
					resolveProjectCheckoutPath(systemConfig, profile.dockerfile),
				),
			);
		}
	}
	const checks = await Promise.all(pendingChecks);
	return checks;
}

async function collectManagedImageOverlayCheck(
	checkName: string,
	overlayPath: string,
): Promise<ConfigValidationCheck> {
	try {
		await validateManagedImageOverlay(overlayPath);
		return {
			name: checkName,
			ok: true,
			hint: overlayPath,
		};
	} catch (error) {
		return {
			name: checkName,
			ok: false,
			hint: getErrorMessage(error),
		};
	}
}

async function collectToolImageProfileChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly ConfigValidationCheck[]> {
	const pendingChecks: Promise<ConfigValidationCheck>[] = [];
	for (const [profileName, profile] of Object.entries(systemConfig.imageProfiles.toolVms)) {
		const buildConfigPath = resolveProjectCheckoutPath(systemConfig, profile.buildConfig);
		pendingChecks.push(
			collectReadableFileCheck(`tool-vm-${profileName}-build-config`, buildConfigPath),
		);
		if (profile.source?.kind === 'managedBase' && profile.source.overlay) {
			const overlayPath = resolveProjectCheckoutPath(systemConfig, profile.source.overlay);
			pendingChecks.push(
				collectManagedImageOverlayCheck(`tool-vm-${profileName}-overlay`, overlayPath),
			);
		}
		if (profile.dockerfile) {
			pendingChecks.push(
				collectReadableFileCheck(
					`tool-vm-${profileName}-dockerfile`,
					resolveProjectCheckoutPath(systemConfig, profile.dockerfile),
				),
			);
		}
	}
	const checks = await Promise.all(pendingChecks);
	return checks;
}

function buildZoneToolVmProfileChecks(
	systemConfig: LoadedSystemConfig,
): readonly ConfigValidationCheck[] {
	return systemConfig.zones.flatMap((zone) => {
		if (zone.gateway.type !== 'openclaw') {
			return [];
		}
		const agentToolVmProfileChecks = Object.entries(zone.agentToolVmProfiles ?? {}).map(
			([agentId, toolVmProfileId]) =>
				({
					name: `zone-agent-tool-vm-profile-${zone.id}-${agentId}`,
					ok: true,
					hint: toolVmProfileId,
				}) satisfies ConfigValidationCheck,
		);
		return [
			zone.defaultToolVmProfile
				? {
						name: `zone-default-tool-vm-profile-${zone.id}`,
						ok: true,
						hint: zone.defaultToolVmProfile,
					}
				: {
						name: `zone-default-tool-vm-profile-${zone.id}`,
						ok: false,
						hint: 'missing defaultToolVmProfile',
					},
			...agentToolVmProfileChecks,
		] as const satisfies readonly ConfigValidationCheck[];
	});
}

function buildOpenClawAgentSetupChecks(
	systemConfig: LoadedSystemConfig,
): readonly ConfigValidationCheck[] {
	return systemConfig.zones.flatMap((zone) => {
		if (zone.gateway.type !== 'openclaw') {
			return [];
		}
		const authProfileChecks = Object.keys(zone.gateway.authProfilesByAgent ?? {}).map(
			(agentId) =>
				({
					name: `zone-agent-auth-profile-${zone.id}-${agentId}`,
					ok: true,
					hint: 'configured',
				}) satisfies ConfigValidationCheck,
		);
		const sandboxSeedChecks = Object.entries(zone.agentSandboxSeeds ?? {}).flatMap(
			([agentId, seeds]) =>
				seeds.map(
					(seed, seedIndex) =>
						({
							name: `zone-agent-sandbox-seed-${zone.id}-${agentId}-${String(seedIndex)}`,
							ok: true,
							hint: seed.target,
						}) satisfies ConfigValidationCheck,
				),
		);
		return [...authProfileChecks, ...sandboxSeedChecks];
	});
}

async function collectMcpPortalConfigChecks(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
): Promise<readonly ConfigValidationCheck[]> {
	if (zone.gateway.type !== 'openclaw' || zone.toolPortal === undefined) {
		return [];
	}
	const configDir = resolveProjectCheckoutPath(systemConfig, zone.toolPortal.configDir);
	const mcpConfigPath = path.join(configDir, 'mcp.config.jsonc');
	const mcpPortalConfigPath = path.join(configDir, 'mcp-portal.config.jsonc');
	const checks: ConfigValidationCheck[] = [];
	try {
		await loadMcpConfig(mcpConfigPath);
		checks.push({ name: `mcp-config-${zone.id}`, ok: true, hint: mcpConfigPath });
	} catch (error) {
		checks.push({
			name: `mcp-config-${zone.id}`,
			ok: false,
			hint: `Missing or invalid ${mcpConfigPath}: ${getErrorMessage(error)}`,
		});
	}

	try {
		const portalConfig = await loadMcpPortalConfig(mcpPortalConfigPath);
		checks.push({ name: `mcp-portal-config-${zone.id}`, ok: true, hint: mcpPortalConfigPath });
		const declaredAgentIds = new Set((zone.agents ?? []).map((agent) => agent.id));
		for (const agent of zone.agents ?? []) {
			const portalAgent = portalConfig.agents[agent.id];
			if (portalAgent === undefined) {
				checks.push({
					name: `mcp-portal-agent-${zone.id}-${agent.id}`,
					ok: false,
					hint: `Agent '${agent.id}' is missing from mcp-portal.config.jsonc agents.`,
				});
				continue;
			}
			try {
				resolveMcpPortalProfile(portalConfig, portalAgent.profile);
				checks.push({
					name: `mcp-portal-profile-${zone.id}-${agent.id}`,
					ok: true,
					hint: portalAgent.profile,
				});
			} catch {
				checks.push({
					name: `mcp-portal-profile-${zone.id}-${agent.id}`,
					ok: false,
					hint: `Agent '${agent.id}' references unknown MCP Portal profile '${portalAgent.profile}'.`,
				});
			}
		}
		for (const agentId of Object.keys(portalConfig.agents)) {
			if (declaredAgentIds.has(agentId)) {
				continue;
			}
			checks.push({
				name: `mcp-portal-agent-declared-${zone.id}-${agentId}`,
				ok: false,
				hint: `mcp-portal.config.jsonc declares agent '${agentId}' that is not in zones[].agents.`,
			});
		}
	} catch (error) {
		checks.push({
			name: `mcp-portal-config-${zone.id}`,
			ok: false,
			hint: `Missing or invalid ${mcpPortalConfigPath}: ${getErrorMessage(error)}`,
		});
	}
	try {
		const allowedRawEnvSecretNames =
			zone.gateway.type === 'openclaw'
				? ['OPENCLAW_GATEWAY_TOKEN', ...(zone.gateway.rawEnvSecrets ?? [])]
				: [];
		await planMcpPortalEffectiveConfig({
			authoredConfigDir: configDir,
			effectiveHostConfigDir: path.join(systemConfig.cacheDir, zone.id, 'tool-portal-effective'),
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
			allowedRawEnvSecretNames,
			declaredAgentIds: (zone.agents ?? []).map((agent) => agent.id),
			includeZoneGitControllerHostAction:
				zone.gateway.type === 'openclaw' && zone.gateway.zoneGit !== undefined,
			secretResolver: validationOnlySecretResolver,
			zoneId: zone.id,
		});
		checks.push({
			name: `tool-portal-effective-config-${zone.id}`,
			ok: true,
			hint: configDir,
		});
	} catch (error) {
		checks.push({
			name: `tool-portal-effective-config-${zone.id}`,
			ok: false,
			hint: `Invalid MCP Portal materialization config in ${configDir}: ${getErrorMessage(error)}`,
		});
	}
	return checks;
}

export async function runConfigValidation(
	options: RunConfigValidationOptions,
): Promise<ConfigValidationResult> {
	const systemConfig = options.systemConfig;
	const runCommand = options.runCommand ?? runCommandDefault;
	const zoneConfigChecks = await Promise.all(
		systemConfig.zones.map(async (zone) =>
			zone.gateway.type === 'worker'
				? await collectWorkerConfigCheck(systemConfig, zone)
				: await collectGatewayConfigCheck(systemConfig, zone),
		),
	);
	const toolPortalConfigChecks = (
		await Promise.all(
			systemConfig.zones.map(
				async (zone) => await collectMcpPortalConfigChecks(systemConfig, zone),
			),
		)
	).flat();
	const liveMcpPortalChecks =
		options.mcpLive === true
			? await (options.runLiveMcpPortalValidation ?? runLiveMcpPortalValidation)({
					secretResolver:
						options.secretResolver ??
						(() => {
							throw new Error('agent-vm validate --mcp-live requires a secret resolver.');
						})(),
					systemConfig,
				})
			: [];
	const vmHostSystemCheck = await collectVmHostSystemDoctorCheck(systemConfig);
	const checks = [
		...buildRuntimePathIsolationChecks(systemConfig),
		...(await collectGatewayImageProfileChecks(systemConfig)),
		...(await collectToolImageProfileChecks(systemConfig)),
		...(await collectOpenClawDeploymentRequirementFindings(systemConfig)).map(
			(finding) =>
				({
					name: finding.id,
					ok: finding.ok,
					hint: finding.hint,
				}) satisfies ConfigValidationCheck,
		),
		...buildZoneToolVmProfileChecks(systemConfig),
		...buildOpenClawAgentSetupChecks(systemConfig),
		...buildOpenClawAgentSecretAccessChecks(systemConfig),
		...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
		...zoneConfigChecks,
		...toolPortalConfigChecks,
		...liveMcpPortalChecks,
		...(await collectOpenClawConfigChecks(systemConfig, runCommand)),
	] as const satisfies readonly ConfigValidationCheck[];

	return {
		ok: !checks.some(isBlockingValidationCheck),
		checks,
	};
}
