import { execFileSync } from 'node:child_process';

import type { SystemConfig } from '../config/system-config.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
	resolveZoneId,
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
		| 'start'
		| 'status'
		| 'stop'
		| 'upgrade';
	readonly systemConfig: SystemConfig;
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
				'age',
				'op',
				'security',
			] as const);
			writeJson(
				options.io,
				options.dependencies.runControllerDoctor({
					availableBinaries,
					env: process.env,
					nodeVersion: process.version,
					systemConfig: options.systemConfig,
				}),
			);
			return;
		}
		case 'status':
			writeJson(options.io, await controllerClient.getControllerStatus());
			return;
		case 'stop':
			writeJson(options.io, await controllerClient.stopController());
			return;
		case 'start': {
			const firstZone = options.systemConfig.zones[0];
			if (!firstZone) {
				throw new Error('System config does not define any zones.');
			}

			const runtime = await options.dependencies.startControllerRuntime({
				systemConfig: options.systemConfig,
				zoneId: firstZone.id,
			});
			writeJson(options.io, {
				controllerPort: runtime.controllerPort,
				ingress: runtime.gateway.ingress,
				vmId: runtime.gateway.vm.id,
				zoneId: firstZone.id,
			});
			return;
		}
		case 'destroy': {
			const zoneId = resolveZoneId(options.systemConfig, options.restArguments);
			writeJson(
				options.io,
				await controllerClient.destroyZone(zoneId, options.restArguments.includes('--purge')),
			);
			return;
		}
		case 'upgrade': {
			const zoneId = resolveZoneId(options.systemConfig, options.restArguments);
			writeJson(options.io, await controllerClient.upgradeZone(zoneId));
			return;
		}
		case 'logs': {
			const zoneId = resolveZoneId(options.systemConfig, options.restArguments);
			writeJson(options.io, await controllerClient.getZoneLogs(zoneId));
			return;
		}
		case 'credentials': {
			if (options.restArguments[0] !== 'refresh') {
				throw new Error(
					`Unknown controller credentials subcommand '${options.restArguments[0] ?? 'undefined'}'.`,
				);
			}

			const zoneId = resolveZoneId(options.systemConfig, options.restArguments);
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
