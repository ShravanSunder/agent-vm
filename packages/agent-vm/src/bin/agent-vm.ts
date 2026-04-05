#!/usr/bin/env node
import fs from 'node:fs/promises';

import { createSecretResolver } from 'gondolin-core';

import { runControllerCredentialsRefresh } from '../features/controller/credentials-refresh.js';
import { runControllerDestroy } from '../features/controller/destroy.js';
import { runControllerDoctor } from '../features/controller/doctor.js';
import { startGatewayZone } from '../features/controller/gateway-manager.js';
import { runControllerLogs } from '../features/controller/logs.js';
import { buildControllerStatus } from '../features/controller/status.js';
import { loadSystemConfig } from '../features/controller/system-config.js';
import { runControllerUpgrade } from '../features/controller/upgrade.js';

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

function resolveZoneId(
	systemConfig: ReturnType<typeof loadSystemConfig>,
	argv: readonly string[],
): string {
	const zoneFlagIndex = argv.indexOf('--zone');
	if (zoneFlagIndex >= 0) {
		return argv[zoneFlagIndex + 1] ?? '';
	}
	return systemConfig.zones[0]?.id ?? '';
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
		case 'destroy': {
			const zoneId = resolveZoneId(systemConfig, restArguments);
			const purge = restArguments.includes('--purge');
			writeJson(
				await runControllerDestroy(
					{
						purge,
						systemConfig,
						zoneId,
					},
					{
						releaseZoneLeases: async () => {},
						stopGatewayZone: async () => {},
					},
				),
			);
			return;
		}
		case 'upgrade': {
			const zoneId = resolveZoneId(systemConfig, restArguments);
			writeJson(
				await runControllerUpgrade(
					{
						systemConfig,
						zoneId,
					},
					{
						rebuildGatewayImage: async () => {},
						restartGatewayZone: async () => {},
						stopGatewayZone: async () => {},
					},
				),
			);
			return;
		}
		case 'logs': {
			const zoneId = resolveZoneId(systemConfig, restArguments);
			writeJson(
				await runControllerLogs(
					{
						zoneId,
					},
					{
						readGatewayLogs: async (targetZoneId: string) => {
							const zone = systemConfig.zones.find(
								(candidateZone) => candidateZone.id === targetZoneId,
							);
							if (!zone) {
								throw new Error(`Unknown zone '${targetZoneId}'.`);
							}
							const logPath = `${zone.gateway.stateDir}/logs/gateway.log`;
							try {
								return await fs.readFile(logPath, 'utf8');
							} catch {
								return '';
							}
						},
					},
				),
			);
			return;
		}
		case 'credentials': {
			if (restArguments[0] !== 'refresh') {
				throw new Error(
					`Unknown controller credentials subcommand '${restArguments[0] ?? 'undefined'}'.`,
				);
			}
			const zoneId = resolveZoneId(systemConfig, restArguments);
			const serviceAccountTokenEnv = systemConfig.host.secretsProvider.serviceAccountTokenEnv;
			const serviceAccountToken = process.env[serviceAccountTokenEnv];
			if (!serviceAccountToken) {
				throw new Error(
					`Missing required env var '${serviceAccountTokenEnv}' for credentials refresh.`,
				);
			}
			const secretResolver = await createSecretResolver({
				serviceAccountToken,
			});
			writeJson(
				await runControllerCredentialsRefresh(
					{
						zoneId,
					},
					{
						refreshZoneSecrets: async (targetZoneId: string) => {
							const zone = systemConfig.zones.find(
								(candidateZone) => candidateZone.id === targetZoneId,
							);
							if (!zone) {
								throw new Error(`Unknown zone '${targetZoneId}'.`);
							}
							await secretResolver.resolveAll(zone.secrets);
						},
						restartGatewayZone: async () => {},
					},
				),
			);
			return;
		}
	}

	throw new Error(`Unknown controller subcommand '${subcommand}'.`);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
