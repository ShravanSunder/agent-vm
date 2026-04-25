import fs from 'node:fs/promises';
import path from 'node:path';

import { loadWorkerConfigDraft } from '@agent-vm/agent-vm-worker';

import { loadSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { collectVmHostSystemDoctorCheck } from './doctor.js';

export interface ConfigValidationCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly hint?: string;
}

export interface ConfigValidationResult {
	readonly ok: boolean;
	readonly checks: readonly ConfigValidationCheck[];
}

export interface RunConfigValidationOptions {
	readonly systemConfig: LoadedSystemConfig;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function projectRootForSystemConfig(systemConfig: LoadedSystemConfig): string {
	return path.resolve(path.dirname(systemConfig.systemConfigPath), '..');
}

function resolveProjectCheckoutPath(
	systemConfig: LoadedSystemConfig,
	configuredPath: string,
): string {
	const runtimeConfigRoot = '/etc/agent-vm';
	const relativeRuntimePath = path.relative(runtimeConfigRoot, configuredPath);
	if (
		!path.isAbsolute(configuredPath) ||
		relativeRuntimePath.startsWith('..') ||
		path.isAbsolute(relativeRuntimePath)
	) {
		return configuredPath;
	}

	const projectRoot = projectRootForSystemConfig(systemConfig);
	if (relativeRuntimePath === 'system.json') {
		return path.join(projectRoot, 'config', 'system.json');
	}
	if (relativeRuntimePath === 'systemCacheIdentifier.json') {
		return path.join(projectRoot, 'config', 'systemCacheIdentifier.json');
	}
	if (relativeRuntimePath.startsWith(`gateways${path.sep}`) || relativeRuntimePath === 'gateways') {
		return path.join(projectRoot, 'config', relativeRuntimePath);
	}
	return path.join(projectRoot, relativeRuntimePath);
}

async function collectReadableFileCheck(
	name: string,
	filePath: string,
): Promise<ConfigValidationCheck> {
	try {
		await fs.access(filePath);
		return { name, ok: true, hint: filePath };
	} catch (error) {
		return {
			name,
			ok: false,
			hint: `Missing ${filePath}: ${getErrorMessage(error)}`,
		};
	}
}

async function collectSystemCacheIdentifierCheck(
	systemConfig: LoadedSystemConfig,
): Promise<ConfigValidationCheck> {
	try {
		await loadSystemCacheIdentifier({ filePath: systemConfig.systemCacheIdentifierPath });
		return {
			name: 'system-cache-identifier',
			ok: true,
			hint: systemConfig.systemCacheIdentifierPath,
		};
	} catch (error) {
		return {
			name: 'system-cache-identifier',
			ok: false,
			hint: getErrorMessage(error),
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

async function collectGatewayImageProfileChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly ConfigValidationCheck[]> {
	const pendingChecks: Promise<ConfigValidationCheck>[] = [];
	for (const [profileName, profile] of Object.entries(systemConfig.imageProfiles.gateways)) {
		const buildConfigPath = resolveProjectCheckoutPath(systemConfig, profile.buildConfig);
		pendingChecks.push(
			collectReadableFileCheck(`gateway-${profileName}-build-config`, buildConfigPath),
		);
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

async function collectToolImageProfileChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly ConfigValidationCheck[]> {
	const pendingChecks: Promise<ConfigValidationCheck>[] = [];
	for (const [profileName, profile] of Object.entries(systemConfig.imageProfiles.toolVms)) {
		const buildConfigPath = resolveProjectCheckoutPath(systemConfig, profile.buildConfig);
		pendingChecks.push(
			collectReadableFileCheck(`tool-vm-${profileName}-build-config`, buildConfigPath),
		);
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

export async function runConfigValidation(
	options: RunConfigValidationOptions,
): Promise<ConfigValidationResult> {
	const systemConfig = options.systemConfig;
	const zoneConfigChecks = await Promise.all(
		systemConfig.zones.map(async (zone) =>
			zone.gateway.type === 'worker'
				? await collectWorkerConfigCheck(systemConfig, zone)
				: await collectGatewayConfigCheck(systemConfig, zone),
		),
	);
	const vmHostSystemCheck = await collectVmHostSystemDoctorCheck(systemConfig);
	const checks = [
		await collectSystemCacheIdentifierCheck(systemConfig),
		...(await collectGatewayImageProfileChecks(systemConfig)),
		...(await collectToolImageProfileChecks(systemConfig)),
		...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
		...zoneConfigChecks,
	] as const satisfies readonly ConfigValidationCheck[];

	return {
		ok: checks.every((check) => check.ok),
		checks,
	};
}
