import { execFileSync } from 'node:child_process';

import { loadWorkerConfig } from '@agent-vm/agent-vm-worker';

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

function collectAvailableBinaryNames(requiredBinaries: readonly string[]): ReadonlySet<string> {
	const availableBinaries = new Set<string>();
	for (const binary of requiredBinaries) {
		try {
			execFileSync('which', [binary], { stdio: 'ignore' });
			availableBinaries.add(binary);
		} catch {
			// Binary not found on the host.
		}
	}
	return availableBinaries;
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
			await loadWorkerConfig(zone.gateway.config);
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
			const availableBinaries = collectAvailableBinaryNames([
				'qemu-system-aarch64',
				'qemu-system-x86_64',
				'op',
				'security',
			] as const);
			const doctorResult = options.dependencies.runControllerDoctor({
				availableBinaries,
				env: process.env,
				nodeVersion: process.version,
				systemConfig: options.systemConfig,
			});
			const workerGatewayConfigChecks = await collectWorkerGatewayConfigChecks(
				options.systemConfig,
			);
			const systemCacheIdentifierCheck = await collectSystemCacheIdentifierCheck(
				options.systemConfig,
			);
			const vmHostSystemCheck = await collectVmHostSystemDoctorCheck(options.systemConfig);
			const dynamicChecks = [
				systemCacheIdentifierCheck,
				...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
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
