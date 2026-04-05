#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createSecretResolver, type SecretResolver } from 'gondolin-core';

import { runControllerCredentialsRefresh } from '../features/controller/credentials-refresh.js';
import { runControllerDestroy } from '../features/controller/destroy.js';
import { runControllerDoctor } from '../features/controller/doctor.js';
import { startGatewayZone } from '../features/controller/gateway-manager.js';
import { runControllerLogs } from '../features/controller/logs.js';
import { buildControllerStatus } from '../features/controller/status.js';
import { loadSystemConfig, type SystemConfig } from '../features/controller/system-config.js';
import { runControllerUpgrade } from '../features/controller/upgrade.js';

interface CliDependencies {
	readonly buildControllerStatus: typeof buildControllerStatus;
	readonly createSecretResolver: typeof createSecretResolver;
	readonly loadSystemConfig: typeof loadSystemConfig;
	readonly runControllerDoctor: typeof runControllerDoctor;
	readonly startGatewayZone: typeof startGatewayZone;
}

interface CliIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

function writeJson(io: CliIo, value: unknown): void {
	io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function resolveConfigPath(argv: readonly string[]): string {
	const configFlagIndex = argv.indexOf('--config');
	if (configFlagIndex >= 0) {
		return argv[configFlagIndex + 1] ?? 'system.json';
	}
	return 'system.json';
}

function resolveZoneId(systemConfig: SystemConfig, argv: readonly string[]): string {
	const zoneFlagIndex = argv.indexOf('--zone');
	if (zoneFlagIndex >= 0) {
		return argv[zoneFlagIndex + 1] ?? '';
	}
	return systemConfig.zones[0]?.id ?? '';
}

async function createResolverFromEnv(
	systemConfig: SystemConfig,
	createSecretResolverImpl: CliDependencies['createSecretResolver'],
): Promise<SecretResolver> {
	const serviceAccountTokenEnv = systemConfig.host.secretsProvider.serviceAccountTokenEnv;
	const serviceAccountToken = process.env[serviceAccountTokenEnv];
	if (!serviceAccountToken) {
		throw new Error(`Missing required env var '${serviceAccountTokenEnv}'.`);
	}

	return await createSecretResolverImpl({
		serviceAccountToken,
	});
}

export async function runAgentVmCli(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = {
		buildControllerStatus,
		createSecretResolver,
		loadSystemConfig,
		runControllerDoctor,
		startGatewayZone,
	},
): Promise<void> {
	const [commandGroup, subcommand, ...restArguments] = argv;
	if (commandGroup !== 'controller') {
		throw new Error('Expected command group "controller".');
	}
	if (subcommand === undefined) {
		throw new Error('Expected a controller subcommand.');
	}

	const systemConfig = dependencies.loadSystemConfig(resolveConfigPath(restArguments));

	switch (subcommand) {
		case 'doctor':
			writeJson(
				io,
				dependencies.runControllerDoctor({
					env: process.env,
					nodeVersion: process.version,
					systemConfig,
				}),
			);
			return;
		case 'status':
			writeJson(io, dependencies.buildControllerStatus(systemConfig));
			return;
		case 'start': {
			const secretResolver = await createResolverFromEnv(
				systemConfig,
				dependencies.createSecretResolver,
			);
			const firstZone = systemConfig.zones[0];
			if (!firstZone) {
				throw new Error('System config does not define any zones.');
			}

			const startedGateway = await dependencies.startGatewayZone({
				secretResolver,
				systemConfig,
				zoneId: firstZone.id,
			});
			writeJson(io, {
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
				io,
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
				io,
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
				io,
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
			const secretResolver = await createResolverFromEnv(
				systemConfig,
				dependencies.createSecretResolver,
			);
			writeJson(
				io,
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

async function main(): Promise<void> {
	await runAgentVmCli(process.argv.slice(2), {
		stderr: process.stderr,
		stdout: process.stdout,
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main().catch((error: unknown) => {
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 1;
	});
}
