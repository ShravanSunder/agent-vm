import { constants } from 'node:fs';
import fs from 'node:fs/promises';

import { loadWorkerConfigDraft } from '@agent-vm/agent-vm-worker';
import { execa } from 'execa';

import { loadSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import { collectVmHostSystemDoctorCheck, type DoctorCheck } from '../operations/doctor.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	readZoneFlag,
	requireZone,
	resolveControllerBaseUrl,
	writeJson,
} from './agent-vm-cli-support.js';

interface RunControllerOperationCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly subcommand:
		| 'credentials'
		| 'destroy'
		| 'doctor'
		| 'logs'
		| 'status'
		| 'stop'
		| 'upgrade';
	readonly systemConfig: LoadedSystemConfig;
}

interface ImageProfileDoctorTarget {
	readonly buildConfig: string;
	readonly checkName: string;
	readonly dockerfile?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createImageProfileDoctorTarget(
	checkName: string,
	buildConfig: string,
	dockerfile: string | undefined,
): ImageProfileDoctorTarget {
	const target: {
		buildConfig: string;
		checkName: string;
		dockerfile?: string;
	} = { buildConfig, checkName };
	if (dockerfile !== undefined) {
		target.dockerfile = dockerfile;
	}
	return target;
}

async function collectAvailableBinaryNames(
	requiredBinaries: readonly string[],
): Promise<ReadonlySet<string>> {
	const availableBinaries = new Set<string>();
	for (const binary of requiredBinaries) {
		try {
			if (binary.includes('/')) {
				// oxlint-disable-next-line no-await-in-loop -- stable check order makes doctor output deterministic
				await fs.access(binary, constants.X_OK);
			} else {
				// oxlint-disable-next-line no-await-in-loop -- stable check order makes doctor output deterministic
				await execa('which', [binary], { stderr: 'ignore', stdout: 'ignore' });
			}
			availableBinaries.add(binary);
		} catch {
			// Binary not found on the host.
		}
	}
	return availableBinaries;
}

async function collectCommandOutput(
	command: string,
	arguments_: readonly string[],
): Promise<string | undefined> {
	try {
		const result = await execa(command, [...arguments_]);
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

async function collectDockerDaemonReady(availableBinaries: ReadonlySet<string>): Promise<boolean> {
	if (!availableBinaries.has('docker')) {
		return false;
	}
	try {
		await execa('docker', ['info'], { stderr: 'ignore', stdout: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

async function collectImageProfileDockerfileChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly DoctorCheck[]> {
	const imageProfileTargets: readonly ImageProfileDoctorTarget[] = [
		...Object.entries(systemConfig.imageProfiles.gateways).map(([profileName, profile]) =>
			createImageProfileDoctorTarget(
				`gateway-image-profile-${profileName}-dockerfile`,
				profile.buildConfig,
				profile.dockerfile,
			),
		),
		...Object.entries(systemConfig.imageProfiles.toolVms).map(([profileName, profile]) =>
			createImageProfileDoctorTarget(
				`tool-vm-image-profile-${profileName}-dockerfile`,
				profile.buildConfig,
				profile.dockerfile,
			),
		),
	];
	const checks: DoctorCheck[] = [];

	for (const imageProfileTarget of imageProfileTargets) {
		let buildConfig: unknown;
		try {
			// oxlint-disable-next-line no-await-in-loop -- stable doctor output order follows system.json order
			buildConfig = JSON.parse(await fs.readFile(imageProfileTarget.buildConfig, 'utf8'));
		} catch {
			// validate already reports missing or malformed build-config.json files.
			continue;
		}

		const ociConfig = isObjectRecord(buildConfig) ? buildConfig.oci : undefined;
		if (!isObjectRecord(ociConfig) || ociConfig.pullPolicy !== 'never') {
			continue;
		}

		const imageName = typeof ociConfig.image === 'string' ? ociConfig.image : 'configured image';
		checks.push({
			name: imageProfileTarget.checkName,
			ok: imageProfileTarget.dockerfile !== undefined,
			hint:
				imageProfileTarget.dockerfile ??
				`pullPolicy=never requires a dockerfile producer for ${imageName}`,
		});
	}

	return checks;
}

async function collectWorkerGatewayConfigChecks(
	systemConfig: SystemConfig,
): Promise<readonly DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	for (const zone of systemConfig.zones) {
		if (zone.gateway.type !== 'worker') {
			continue;
		}
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			await loadWorkerConfigDraft(zone.gateway.config);
			checks.push({
				name: `worker-config-${zone.id}`,
				ok: true,
				hint: zone.gateway.config,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checks.push({
				name: `worker-config-${zone.id}`,
				ok: false,
				hint: message,
			});
		}
	}
	return checks;
}

async function collectSystemCacheIdentifierCheck(
	systemConfig: LoadedSystemConfig,
): Promise<DoctorCheck> {
	try {
		await loadSystemCacheIdentifier({ filePath: systemConfig.systemCacheIdentifierPath });
		return {
			name: 'system-cache-identifier',
			ok: true,
			hint: systemConfig.systemCacheIdentifierPath,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: 'system-cache-identifier',
			ok: false,
			hint: message,
		};
	}
}

export async function runControllerOperationCommand(
	options: RunControllerOperationCommandOptions,
): Promise<void> {
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});

	switch (options.subcommand) {
		case 'doctor': {
			const availableBinaries = await collectAvailableBinaryNames([
				'qemu-system-aarch64',
				'qemu-system-x86_64',
				'qemu-img',
				'docker',
				'op',
				'security',
				'mke2fs',
				'mkfs.ext4',
				'/opt/homebrew/opt/e2fsprogs/sbin/mke2fs',
				'/usr/local/opt/e2fsprogs/sbin/mke2fs',
				'debugfs',
				'/opt/homebrew/opt/e2fsprogs/sbin/debugfs',
				'/usr/local/opt/e2fsprogs/sbin/debugfs',
				'cpio',
				'lz4',
			] as const);
			const requiredZigVersion = await options.dependencies.resolveGondolinMinimumZigVersion();
			const zigVersion = await collectCommandOutput('zig', ['version']);
			const dockerDaemonReady = await collectDockerDaemonReady(availableBinaries);
			const doctorResult = options.dependencies.runControllerDoctor({
				availableBinaries,
				dockerDaemonReady,
				env: process.env,
				nodeVersion: process.version,
				requiredZigVersion,
				systemConfig: options.systemConfig,
				...(zigVersion ? { zigVersion } : {}),
			});
			const workerGatewayConfigChecks = await collectWorkerGatewayConfigChecks(
				options.systemConfig,
			);
			const imageProfileDockerfileChecks = await collectImageProfileDockerfileChecks(
				options.systemConfig,
			);
			const systemCacheIdentifierCheck = await collectSystemCacheIdentifierCheck(
				options.systemConfig,
			);
			const vmHostSystemCheck = await collectVmHostSystemDoctorCheck(options.systemConfig);
			const dynamicChecks = [
				systemCacheIdentifierCheck,
				...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
				...imageProfileDockerfileChecks,
				...workerGatewayConfigChecks,
			] as const satisfies readonly DoctorCheck[];
			writeJson(options.io, {
				ok: doctorResult.ok && dynamicChecks.every((check) => check.ok),
				checks: [...doctorResult.checks, ...dynamicChecks],
			});
			return;
		}
		case 'status':
			writeJson(options.io, await controllerClient.getControllerStatus());
			return;
		case 'stop':
			writeJson(options.io, await controllerClient.stopController());
			return;
		case 'destroy': {
			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			writeJson(
				options.io,
				await controllerClient.destroyZone(zoneId, options.restArguments.includes('--purge')),
			);
			return;
		}
		case 'upgrade': {
			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			writeJson(options.io, await controllerClient.upgradeZone(zoneId));
			return;
		}
		case 'logs': {
			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			writeJson(options.io, await controllerClient.getZoneLogs(zoneId));
			return;
		}
		case 'credentials': {
			if (options.restArguments[0] !== 'refresh') {
				throw new Error(
					`Unknown controller credentials subcommand '${options.restArguments[0] ?? 'undefined'}'.`,
				);
			}

			const zoneId = requireZone(options.systemConfig, readZoneFlag(options.restArguments)).id;
			const secretResolver = await createResolverFromSystemConfig(
				options.systemConfig,
				options.dependencies,
			);
			await resolveZoneSecrets({
				secretResolver,
				systemConfig: options.systemConfig,
				zoneId,
			});
			writeJson(options.io, await controllerClient.refreshZoneCredentials(zoneId));
			return;
		}
	}
}
