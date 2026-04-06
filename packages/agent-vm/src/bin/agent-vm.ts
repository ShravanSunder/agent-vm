#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { createSecretResolver, type SecretResolver } from 'gondolin-core';

import { createControllerClient } from '../features/controller/controller-client.js';
import { startControllerRuntime } from '../features/controller/controller-runtime.js';
import { runControllerDoctor } from '../features/controller/doctor.js';
import { startGatewayZone } from '../features/controller/gateway-manager.js';
import { buildControllerStatus } from '../features/controller/status.js';
import { loadSystemConfig, type SystemConfig } from '../features/controller/system-config.js';

interface CliDependencies {
	readonly buildControllerStatus: typeof buildControllerStatus;
	readonly createControllerClient: typeof createControllerClient;
	readonly createSecretResolver: typeof createSecretResolver;
	readonly loadSystemConfig: typeof loadSystemConfig;
	readonly runControllerDoctor: typeof runControllerDoctor;
	readonly startControllerRuntime: (options: {
		readonly pluginSourceDir: string;
		readonly systemConfig: SystemConfig;
		readonly zoneId: string;
	}) => Promise<{
		readonly controllerPort: number;
		readonly gateway: {
			readonly ingress: {
				readonly host: string;
				readonly port: number;
			};
			readonly vm: {
				readonly id: string;
			};
		};
	}>;
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

function resolveBundledPluginSourceDir(): string {
	return new URL('../../../openclaw-agent-vm-plugin/src/', import.meta.url).pathname;
}

function resolveZoneId(systemConfig: SystemConfig, argv: readonly string[]): string {
	const zoneFlagIndex = argv.indexOf('--zone');
	if (zoneFlagIndex >= 0) {
		return argv[zoneFlagIndex + 1] ?? '';
	}
	return systemConfig.zones[0]?.id ?? '';
}

function resolveControllerBaseUrl(systemConfig: SystemConfig): string {
	return `http://127.0.0.1:${systemConfig.host.controllerPort}`;
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
		createControllerClient,
		createSecretResolver,
		loadSystemConfig,
		runControllerDoctor,
		startControllerRuntime: async (runtimeOptions) =>
			await startControllerRuntime(runtimeOptions, {
				createManagedToolVm: async () => {
					throw new Error('Tool VM creation is not wired in CLI defaults yet.');
				},
			}),
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
			writeJson(
				io,
				await dependencies
					.createControllerClient({
						baseUrl: resolveControllerBaseUrl(systemConfig),
					})
					.getStatus(),
			);
			return;
		case 'start': {
			const firstZone = systemConfig.zones[0];
			if (!firstZone) {
				throw new Error('System config does not define any zones.');
			}

			const runtime = await dependencies.startControllerRuntime({
				pluginSourceDir: resolveBundledPluginSourceDir(),
				systemConfig,
				zoneId: firstZone.id,
			});
			writeJson(io, {
				controllerPort: runtime.controllerPort,
				ingress: runtime.gateway.ingress,
				vmId: runtime.gateway.vm.id,
				zoneId: firstZone.id,
			});
			return;
		}
		case 'destroy': {
			const zoneId = resolveZoneId(systemConfig, restArguments);
			const purge = restArguments.includes('--purge');
			writeJson(
				io,
				await dependencies
					.createControllerClient({
						baseUrl: resolveControllerBaseUrl(systemConfig),
					})
					.destroyZone(zoneId, purge),
			);
			return;
		}
		case 'upgrade': {
			const zoneId = resolveZoneId(systemConfig, restArguments);
			writeJson(
				io,
				await dependencies
					.createControllerClient({
						baseUrl: resolveControllerBaseUrl(systemConfig),
					})
					.upgradeZone(zoneId),
			);
			return;
		}
		case 'logs': {
			const zoneId = resolveZoneId(systemConfig, restArguments);
			writeJson(
				io,
				await dependencies
					.createControllerClient({
						baseUrl: resolveControllerBaseUrl(systemConfig),
					})
					.getLogs(zoneId),
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
			const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
			if (!zone) {
				throw new Error(`Unknown zone '${zoneId}'.`);
			}
			await secretResolver.resolveAll(zone.secrets);
			writeJson(
				io,
				await dependencies
					.createControllerClient({
						baseUrl: resolveControllerBaseUrl(systemConfig),
					})
					.refreshCredentials(zoneId),
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
