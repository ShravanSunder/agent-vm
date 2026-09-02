import { access } from 'node:fs/promises';
import path from 'node:path';

import { loadWorkerConfigDraft } from '@agent-vm/agent-vm-worker';
import {
	loadMcpConfig,
	loadOAuthConfig,
	loadToolPortalConfig,
	validateOAuthToolPortalConfigPair,
	type ToolPortalConfig,
} from '@agent-vm/config-contracts';
import { loadHermesManagedConfiguration } from '@agent-vm/hermes-gateway';
import type { SecretResolver } from '@agent-vm/secret-management';

import { validateManagedImageOverlay } from '../build/managed-image-dockerfile.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { assertOAuthListenerPortAvailable } from '../controller/oauth/oauth-listener-port-validation.js';
import {
	managedToolPortalRequiresApprovalAccess,
	planMcpPortalEffectiveConfig,
} from '../gateway/mcp-portal-effective-config.js';
import { buildManagedAgentSecretAccessChecks } from './agent-secret-access-checks.js';
import {
	type ConfigValidationCheck,
	type ConfigValidationResult,
	resolveProjectCheckoutPath,
} from './config-validation-shared.js';
import { buildRuntimePathIsolationChecks, collectVmHostSystemDoctorCheck } from './doctor.js';
import { runLiveMcpPortalValidation } from './mcp-portal-live-validation.js';

export { type ConfigValidationCheck, type ConfigValidationResult, resolveProjectCheckoutPath };

export interface RunConfigValidationOptions {
	readonly mcpLive?: boolean;
	readonly runLiveMcpPortalValidation?: typeof runLiveMcpPortalValidation;
	readonly secretResolver?: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isBlockingValidationCheck(check: ConfigValidationCheck): boolean {
	return !check.ok && check.status !== 'unavailable';
}

const validationOnlySecretResolver = {
	resolve: async (): Promise<string> => '',
	resolveAll: async (): Promise<Record<string, string>> => ({}),
};

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

async function collectHermesConfigCheck(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
): Promise<ConfigValidationCheck> {
	const gatewayConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
	try {
		await loadHermesManagedConfiguration(gatewayConfigPath);
		return {
			hint: gatewayConfigPath,
			name: `hermes-config-${zone.id}`,
			ok: true,
		};
	} catch (error: unknown) {
		return {
			hint: getErrorMessage(error),
			name: `hermes-config-${zone.id}`,
			ok: false,
		};
	}
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
		if (zone.gateway.type === 'worker') {
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

async function collectToolPortalConfigChecks(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
): Promise<readonly ConfigValidationCheck[]> {
	if (zone.gateway.type === 'worker' || zone.toolPortal === undefined) {
		return [];
	}
	const configDir = resolveProjectCheckoutPath(systemConfig, zone.toolPortal.configDir);
	const mcpConfigPath = path.join(configDir, 'mcp.config.jsonc');
	const toolPortalConfigPath = path.join(configDir, 'tool-portal.config.jsonc');
	const oauthConfigPath = path.join(configDir, 'oauth.config.jsonc');
	const checks: ConfigValidationCheck[] = [];
	let loadedToolPortalConfig: ToolPortalConfig | undefined;
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
		const toolPortalConfig = await loadToolPortalConfig(toolPortalConfigPath);
		loadedToolPortalConfig = toolPortalConfig;
		checks.push({ name: `tool-portal-config-${zone.id}`, ok: true, hint: toolPortalConfigPath });
		const requiresApprovalAccess = managedToolPortalRequiresApprovalAccess(toolPortalConfig);
		const approvalAccessConfigured = zone.approvalAccess !== undefined;
		checks.push(
			requiresApprovalAccess && !approvalAccessConfigured
				? {
						hint: `Managed Tool Portal calls requiring approval for zone '${zone.id}' require zones[].approvalAccess with at least one authenticated approver.`,
						name: `tool-portal-approval-access-${zone.id}`,
						ok: false,
					}
				: {
						hint: requiresApprovalAccess
							? 'Protected approval access is configured.'
							: 'No managed approval-required calls are configured.',
						name: `tool-portal-approval-access-${zone.id}`,
						ok: true,
					},
		);
		const declaredAgentIds = new Set((zone.agents ?? []).map((agent) => agent.id));
		for (const agent of zone.agents ?? []) {
			const portalAgent = toolPortalConfig.agents[agent.id];
			if (portalAgent === undefined) {
				checks.push({
					name: `tool-portal-agent-${zone.id}-${agent.id}`,
					ok: false,
					hint: `Agent '${agent.id}' is missing from tool-portal.config.jsonc agents.`,
				});
				continue;
			}
			checks.push({
				name: `tool-portal-profile-${zone.id}-${agent.id}`,
				ok: true,
				hint: portalAgent.profile,
			});
		}
		for (const agentId of Object.keys(toolPortalConfig.agents)) {
			if (declaredAgentIds.has(agentId)) {
				continue;
			}
			checks.push({
				name: `tool-portal-agent-declared-${zone.id}-${agentId}`,
				ok: false,
				hint: `tool-portal.config.jsonc declares agent '${agentId}' that is not in zones[].agents.`,
			});
		}
	} catch (error) {
		checks.push({
			name: `tool-portal-config-${zone.id}`,
			ok: false,
			hint: `Missing or invalid ${toolPortalConfigPath}: ${getErrorMessage(error)}`,
		});
	}
	try {
		await access(oauthConfigPath);
		const oauthConfig = await loadOAuthConfig(oauthConfigPath);
		if (loadedToolPortalConfig === undefined) {
			throw new Error('OAuth config requires a valid sibling Tool Portal config.');
		}
		validateOAuthToolPortalConfigPair({
			oauthConfig,
			toolPortalConfig: loadedToolPortalConfig,
		});
		assertOAuthListenerPortAvailable({
			oauthPort: oauthConfig.browser.listener.port,
			systemConfig,
		});
		checks.push({ name: `oauth-config-${zone.id}`, ok: true, hint: oauthConfigPath });
	} catch (error) {
		if (!isMissingFileError(error)) {
			checks.push({
				name: `oauth-config-${zone.id}`,
				ok: false,
				hint: `Invalid ${oauthConfigPath}: ${getErrorMessage(error)}`,
			});
		}
	}
	try {
		await planMcpPortalEffectiveConfig({
			approvalAccessConfigured: zone.approvalAccess !== undefined,
			authoredConfigDir: configDir,
			effectiveHostConfigDir: path.join(systemConfig.cacheDir, zone.id, 'tool-portal-effective'),
			allowedRawEnvSecretNames: [],
			declaredAgentIds: (zone.agents ?? []).map((agent) => agent.id),
			secretResolver: validationOnlySecretResolver,
			workspaceGitPushAgentEligibility: {
				eligibleAgentIds: (zone.agents ?? [])
					.filter((agent) => agent.workspaceGit?.mode === 'remote')
					.map((agent) => agent.id),
			},
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
			hint: `Invalid managed Tool Portal materialization config in ${configDir}: ${getErrorMessage(error)}`,
		});
	}
	return checks;
}

export async function runConfigValidation(
	options: RunConfigValidationOptions,
): Promise<ConfigValidationResult> {
	const systemConfig = options.systemConfig;
	const zoneConfigChecks = await Promise.all(
		systemConfig.zones.map(async (zone) => {
			switch (zone.gateway.type) {
				case 'hermes':
					return await collectHermesConfigCheck(systemConfig, zone);
				case 'worker':
					return await collectWorkerConfigCheck(systemConfig, zone);
			}
		}),
	);
	const toolPortalConfigChecks = (
		await Promise.all(
			systemConfig.zones.map(
				async (zone) => await collectToolPortalConfigChecks(systemConfig, zone),
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
		...buildZoneToolVmProfileChecks(systemConfig),
		...buildManagedAgentSecretAccessChecks(systemConfig),
		...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
		...zoneConfigChecks,
		...toolPortalConfigChecks,
		...liveMcpPortalChecks,
	] as const satisfies readonly ConfigValidationCheck[];

	return {
		ok: !checks.some(isBlockingValidationCheck),
		checks,
	};
}
