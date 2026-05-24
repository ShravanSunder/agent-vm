// oxlint-disable typescript-eslint/explicit-function-return-type
import fs from 'node:fs/promises';
import path from 'node:path';

import { command, flag, positional, string, subcommands } from 'cmd-ts';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';
import { runControllerOfflineCleanup } from '../../operations/controller-offline-cleanup.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { runLeaseCommand } from '../lease-commands.js';
import { createRunTask } from '../run-task.js';
import { runSshCommand } from '../ssh-commands.js';
import {
	appendZoneArgument,
	createConfigOption,
	createPurgeFlag,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

function createControllerOperationSubcommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: {
		readonly name: 'destroy' | 'logs' | 'status' | 'stop' | 'upgrade';
		readonly description: string;
		readonly supportsPurge?: boolean;
		readonly supportsZone?: boolean;
	},
) {
	return command({
		name: options.name,
		description: options.description,
		args: {
			config: createConfigOption(),
			...(options.supportsZone ? { zone: createZoneOption() } : {}),
			...(options.supportsPurge ? { purge: createPurgeFlag() } : {}),
		},
		handler: async ({ config, ...rest }) => {
			const systemConfig = await loadSystemConfigFromOption(config, dependencies);
			const zoneFlag = options.supportsZone && 'zone' in rest ? rest.zone : undefined;
			const selectedZone = options.supportsZone ? requireZone(systemConfig, zoneFlag) : undefined;
			const argumentPrefix =
				options.supportsPurge && 'purge' in rest && rest.purge ? ['--purge'] : [];
			const restArguments = selectedZone
				? appendZoneArgument(argumentPrefix, selectedZone.id)
				: argumentPrefix;
			await runControllerOperationCommand({
				dependencies,
				io,
				restArguments,
				subcommand: options.name,
				systemConfig,
			});
		},
	});
}

export async function isGatewayImageCached(
	systemConfig: LoadedSystemConfig,
	zoneId: string,
): Promise<boolean> {
	const zone = requireZone(systemConfig, zoneId);
	const gatewayImageProfile = systemConfig.imageProfiles.gateways[zone.gateway.imageProfile];
	if (!gatewayImageProfile) {
		throw new Error(`Gateway image profile '${zone.gateway.imageProfile}' is not configured.`);
	}
	const gatewayFingerprint = await computeFingerprintFromConfigPath(
		gatewayImageProfile.buildConfig,
	);
	const gatewayCachePath = path.join(
		systemConfig.cacheDir,
		'gateway-images',
		zone.gateway.imageProfile,
		gatewayFingerprint,
	);
	try {
		await fs.access(path.join(gatewayCachePath, 'manifest.json'));
		return true;
	} catch {
		return false;
	}
}

async function requireGatewayImageCache(
	systemConfig: LoadedSystemConfig,
	zoneId: string,
	dependencies: Pick<CliDependencies, 'isGatewayImageCached'>,
): Promise<void> {
	const cacheIsWarm =
		(await dependencies.isGatewayImageCached?.(systemConfig, zoneId)) ??
		(await isGatewayImageCached(systemConfig, zoneId));
	if (cacheIsWarm) {
		return;
	}

	throw new Error(
		`[start] Gateway image not cached. Run \`agent-vm build\` first, then retry \`agent-vm controller start --zone ${zoneId}\`.`,
	);
}

export function createControllerSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'controller',
		description: 'Manage the VM controller',
		cmds: {
			start: command({
				name: 'start',
				description: 'Boot the controller and gateway',
				args: {
					config: createConfigOption(),
					zone: createZoneOption(),
				},
				handler: async ({ config, zone }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					const selectedZone = requireZone(systemConfig, zone);

					await requireGatewayImageCache(systemConfig, selectedZone.id, dependencies);
					const runTask = await createRunTask(io);
					const runtime = await dependencies.startControllerRuntime(
						{
							systemConfig,
							zoneId: selectedZone.id,
						},
						{ runTask },
					);
					const startedZone = runtime.zones.find(
						(runtimeZone) => runtimeZone.zoneId === selectedZone.id,
					);
					io.stdout.write(
						`${JSON.stringify(
							{
								controllerPort: runtime.controllerPort,
								ingress: startedZone?.gateway?.ingress ?? null,
								vmId: startedZone?.gateway?.vm.id ?? null,
								zoneId: selectedZone.id,
							},
							null,
							2,
						)}\n`,
					);
				},
			}),
			stop: createControllerOperationSubcommand(io, dependencies, {
				description: 'Stop the controller',
				name: 'stop',
			}),
			cleanup: command({
				name: 'cleanup',
				description: 'Clean up recorded gateway VM processes without contacting the controller',
				args: {
					config: createConfigOption(),
					force: flag({
						long: 'force',
						description: 'Allow cleanup even if the controller health endpoint is reachable',
					}),
					zone: createZoneOption(),
				},
				handler: async ({ config, force, zone }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					const selectedZone = requireZone(systemConfig, zone);
					const result = await (
						dependencies.runControllerOfflineCleanup ?? runControllerOfflineCleanup
					)({
						force,
						systemConfig,
						zoneId: selectedZone.id,
					});
					io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
					const cleanupWarnings: string[] = [];
					for (const cleanupResult of result.results) {
						if (cleanupResult.cleanupWarning !== undefined) {
							cleanupWarnings.push(cleanupResult.cleanupWarning);
						}
						cleanupWarnings.push(...cleanupResult.toolVmCleanup.warnings);
					}
					if (cleanupWarnings.length > 0) {
						throw new Error(
							`Controller cleanup completed with warnings: ${cleanupWarnings.join('; ')}`,
						);
					}
				},
			}),
			status: createControllerOperationSubcommand(io, dependencies, {
				description: 'Show controller status',
				name: 'status',
			}),
			ssh: command({
				name: 'ssh',
				description: 'Open an SSH session into the gateway VM',
				args: {
					allSecrets: flag({
						long: 'all-secrets',
						description: 'Load every raw gateway environment secret in the SSH shell',
					}),
					config: createConfigOption(),
					zone: createZoneOption(),
				},
				handler: async ({ allSecrets, config, zone }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					const selectedZone = requireZone(systemConfig, zone);
					const restArguments = [
						'--zone',
						selectedZone.id,
						...(allSecrets ? ['--all-secrets'] : []),
					];
					await runSshCommand({
						dependencies,
						io,
						restArguments,
						systemConfig,
					});
				},
			}),
			destroy: createControllerOperationSubcommand(io, dependencies, {
				description: 'Destroy a zone runtime',
				name: 'destroy',
				supportsPurge: true,
				supportsZone: true,
			}),
			upgrade: createControllerOperationSubcommand(io, dependencies, {
				description: 'Upgrade a zone runtime',
				name: 'upgrade',
				supportsZone: true,
			}),
			logs: createControllerOperationSubcommand(io, dependencies, {
				description: 'Show gateway logs',
				name: 'logs',
				supportsZone: true,
			}),
			credentials: subcommands({
				name: 'credentials',
				description: 'Manage credentials',
				cmds: {
					refresh: command({
						name: 'refresh',
						description: 'Refresh zone credentials',
						args: {
							config: createConfigOption(),
							zone: createZoneOption(),
						},
						handler: async ({ config, zone }) => {
							const systemConfig = await loadSystemConfigFromOption(config, dependencies);
							const selectedZone = requireZone(systemConfig, zone);
							await runControllerOperationCommand({
								dependencies,
								io,
								restArguments: appendZoneArgument(['refresh'], selectedZone.id),
								subcommand: 'credentials',
								systemConfig,
							});
						},
					}),
				},
			}),
			lease: subcommands({
				name: 'lease',
				description: 'Manage tool VM leases',
				cmds: {
					list: command({
						name: 'list',
						description: 'List active leases',
						args: {
							config: createConfigOption(),
						},
						handler: async ({ config }) => {
							await runLeaseCommand({
								dependencies,
								io,
								restArguments: ['list'],
								systemConfig: await loadSystemConfigFromOption(config, dependencies),
							});
						},
					}),
					peek: command({
						name: 'peek',
						description: 'Inspect a lease without extending its idle timer',
						args: {
							config: createConfigOption(),
							leaseId: positional({
								displayName: 'lease-id',
								type: string,
								description: 'Lease identifier to inspect',
							}),
						},
						handler: async ({ config, leaseId }) => {
							await runLeaseCommand({
								dependencies,
								io,
								restArguments: ['peek', leaseId],
								systemConfig: await loadSystemConfigFromOption(config, dependencies),
							});
						},
					}),
					release: command({
						name: 'release',
						description: 'Release a lease',
						args: {
							config: createConfigOption(),
							leaseId: positional({
								displayName: 'lease-id',
								type: string,
								description: 'Lease identifier to release',
							}),
						},
						handler: async ({ config, leaseId }) => {
							await runLeaseCommand({
								dependencies,
								io,
								restArguments: ['release', leaseId],
								systemConfig: await loadSystemConfigFromOption(config, dependencies),
							});
						},
					}),
				},
			}),
		},
	});
}
