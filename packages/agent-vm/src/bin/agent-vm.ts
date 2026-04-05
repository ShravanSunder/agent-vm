#!/usr/bin/env node
import { createSecretResolver } from 'gondolin-core';

import { runControllerDoctor } from '../features/controller/doctor.js';
import { startGatewayZone } from '../features/controller/gateway-manager.js';
import { buildControllerStatus } from '../features/controller/status.js';
import { loadSystemConfig } from '../features/controller/system-config.js';

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function resolveConfigPath(argv: readonly string[]): string {
	const configFlagIndex = argv.indexOf('--config');
	if (configFlagIndex >= 0) {
		return argv[configFlagIndex + 1] ?? 'system.json';
	}
	return 'system.json';
}

async function main(): Promise<void> {
	const [, , commandGroup, subcommand, ...restArguments] = process.argv;
	if (commandGroup !== 'controller') {
		throw new Error('Expected command group "controller".');
	}
	if (subcommand === undefined) {
		throw new Error('Expected a controller subcommand.');
	}

	const systemConfig = loadSystemConfig(resolveConfigPath(restArguments));

	switch (subcommand) {
		case 'doctor': {
			writeJson(
				runControllerDoctor({
					env: process.env,
					nodeVersion: process.version,
					systemConfig,
				}),
			);
			return;
		}
		case 'status': {
			writeJson(buildControllerStatus(systemConfig));
			return;
		}
		case 'start': {
			const serviceAccountTokenEnv = systemConfig.host.secretsProvider.serviceAccountTokenEnv;
			const serviceAccountToken = process.env[serviceAccountTokenEnv];
			if (!serviceAccountToken) {
				throw new Error(
					`Missing required env var '${serviceAccountTokenEnv}' for controller start.`,
				);
			}

			const secretResolver = await createSecretResolver({
				serviceAccountToken,
			});
			const firstZone = systemConfig.zones[0];
			if (!firstZone) {
				throw new Error('System config does not define any zones.');
			}

			const startedGateway = await startGatewayZone({
				secretResolver,
				systemConfig,
				zoneId: firstZone.id,
			});
			writeJson({
				ingress: startedGateway.ingress,
				vmId: startedGateway.vm.id,
				zoneId: firstZone.id,
			});
			return;
		}
	}

	throw new Error(`Unknown controller subcommand '${subcommand}'.`);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
