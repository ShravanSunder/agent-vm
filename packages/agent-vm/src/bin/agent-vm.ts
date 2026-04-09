#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
	createSecretResolver,
	resolveServiceAccountToken,
	type SecretResolver,
} from 'gondolin-core';

import { createControllerClient } from '../features/controller/controller-client.js';
import { startControllerRuntime } from '../features/controller/controller-runtime.js';
import { runControllerDoctor } from '../features/controller/doctor.js';
import { startGatewayZone } from '../features/controller/gateway-manager.js';
import { createAgeEncryption } from '../features/controller/snapshot-encryption.js';
import { createSnapshotManager } from '../features/controller/snapshot-manager.js';
import { buildControllerStatus } from '../features/controller/status.js';
import { loadSystemConfig, type SystemConfig } from '../features/controller/system-config.js';

interface CliDependencies {
	readonly buildControllerStatus: typeof buildControllerStatus;
	readonly createAgeEncryption: typeof createAgeEncryption;
	readonly createControllerClient: typeof createControllerClient;
	readonly createSecretResolver: typeof createSecretResolver;
	readonly createSnapshotManager: typeof createSnapshotManager;
	readonly loadSystemConfig: typeof loadSystemConfig;
	readonly resolveServiceAccountToken: typeof resolveServiceAccountToken;
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
	return new URL('../../../openclaw-agent-vm-plugin/dist/', import.meta.url).pathname;
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

async function createResolverFromConfig(
	systemConfig: SystemConfig,
	dependencies: {
		readonly createSecretResolver: CliDependencies['createSecretResolver'];
		readonly resolveServiceAccountToken: CliDependencies['resolveServiceAccountToken'];
	},
): Promise<SecretResolver> {
	const tokenSource = systemConfig.host.secretsProvider.tokenSource;
	const serviceAccountToken = await dependencies.resolveServiceAccountToken(tokenSource);

	return await dependencies.createSecretResolver({
		serviceAccountToken,
	});
}

export async function runAgentVmCli(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = {
		buildControllerStatus,
		createAgeEncryption,
		createControllerClient,
		createSecretResolver,
		createSnapshotManager,
		loadSystemConfig,
		resolveServiceAccountToken,
		runControllerDoctor,
		startControllerRuntime: async (runtimeOptions) =>
			await startControllerRuntime(runtimeOptions, {}),
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
		case 'doctor': {
			const requiredBinaries = ['qemu-system-aarch64', 'age', 'op', 'security'] as const;
			const availableBinaries = new Set<string>();
			for (const binary of requiredBinaries) {
				try {
					execFileSync('which', [binary], { stdio: 'ignore' });
					availableBinaries.add(binary);
				} catch {
					// Binary not found
				}
			}
			writeJson(
				io,
				dependencies.runControllerDoctor({
					availableBinaries,
					env: process.env,
					nodeVersion: process.version,
					systemConfig,
				}),
			);
			return;
		}
		case 'status':
			writeJson(
				io,
				await dependencies
					.createControllerClient({
						baseUrl: resolveControllerBaseUrl(systemConfig),
					})
					.getControllerStatus(),
			);
			return;
		case 'stop':
			writeJson(
				io,
				await dependencies
					.createControllerClient({
						baseUrl: resolveControllerBaseUrl(systemConfig),
					})
					.stopController(),
			);
			return;
		case 'ssh-cmd': {
			const zoneId = resolveZoneId(systemConfig, restArguments);
			const sshResponse = await dependencies
				.createControllerClient({ baseUrl: resolveControllerBaseUrl(systemConfig) })
				.enableZoneSsh(zoneId);
			const sshInfo = sshResponse as { command?: string; host?: string; port?: number };
			if (sshInfo.command) {
				io.stdout.write(`${sshInfo.command}\n`);
			} else {
				writeJson(io, sshResponse);
			}
			return;
		}
		case 'lease': {
			const leaseSubcommand = restArguments[0];
			if (leaseSubcommand === 'list') {
				writeJson(
					io,
					await dependencies
						.createControllerClient({ baseUrl: resolveControllerBaseUrl(systemConfig) })
						.listLeases(),
				);
				return;
			}
			if (leaseSubcommand === 'release') {
				const leaseId = restArguments[1];
				if (!leaseId) {
					throw new Error('Usage: agent-vm controller lease release <leaseId>');
				}
				await dependencies
					.createControllerClient({ baseUrl: resolveControllerBaseUrl(systemConfig) })
					.releaseLease(leaseId);
				writeJson(io, { ok: true, released: leaseId });
				return;
			}
			throw new Error(
				`Unknown lease subcommand '${leaseSubcommand ?? 'undefined'}'.`,
			);
		}
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
					.getZoneLogs(zoneId),
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
			const secretResolver = await createResolverFromConfig(
				systemConfig,
				{
					createSecretResolver: dependencies.createSecretResolver,
					resolveServiceAccountToken: dependencies.resolveServiceAccountToken,
				},
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
					.refreshZoneCredentials(zoneId),
			);
			return;
		}
		case 'snapshot': {
			const snapshotSubcommand = restArguments[0];
			const zoneId = resolveZoneId(systemConfig, restArguments);
			const zone = systemConfig.zones.find(
				(candidateZone) => candidateZone.id === zoneId,
			);
			if (!zone) {
				throw new Error(`Unknown zone '${zoneId}'.`);
			}
			const snapshotDir = `${zone.gateway.stateDir}/snapshots`;

			if (snapshotSubcommand === 'list') {
				const manager = dependencies.createSnapshotManager({
					encrypt: async () => {},
					decrypt: async () => {},
				});
				writeJson(io, manager.listSnapshots({ snapshotDir, zoneId }));
				return;
			}

			const secretResolver = await createResolverFromConfig(
				systemConfig,
				{
					createSecretResolver: dependencies.createSecretResolver,
					resolveServiceAccountToken: dependencies.resolveServiceAccountToken,
				},
			);
			const encryption = dependencies.createAgeEncryption({
				resolvePassphrase: async () =>
					await secretResolver.resolve({
						source: '1password',
						ref: `op://agent-vm/agent-${zoneId}-snapshot/password`,
					}),
			});
			const manager = dependencies.createSnapshotManager(encryption);

			if (snapshotSubcommand === 'create') {
				writeJson(
					io,
					await manager.createSnapshot({
						zoneId,
						stateDir: zone.gateway.stateDir,
						workspaceDir: zone.gateway.workspaceDir,
						snapshotDir,
					}),
				);
				return;
			}

			if (snapshotSubcommand === 'restore') {
				const snapshotPath = restArguments[1];
				if (!snapshotPath) {
					throw new Error(
						'Usage: agent-vm controller snapshot restore <path> [--zone <id>]',
					);
				}
				writeJson(
					io,
					await manager.restoreSnapshot({
						snapshotPath,
						stateDir: zone.gateway.stateDir,
						workspaceDir: zone.gateway.workspaceDir,
					}),
				);
				return;
			}

			throw new Error(
				`Unknown snapshot subcommand '${snapshotSubcommand ?? 'undefined'}'.`,
			);
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
