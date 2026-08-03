// oxlint-disable typescript-eslint/explicit-function-return-type
import path from 'node:path';

import { command, flag, subcommands } from 'cmd-ts';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import type { ManagedGatewayImageBootProjection } from '../../build/gondolin-managed-vm-build-tooling.js';
import { readPreparedManagedVmImage } from '../../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
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
		readonly name:
			| 'destroy'
			| 'health'
			| 'health-snapshot'
			| 'logs'
			| 'service-health'
			| 'status'
			| 'stop'
			| 'upgrade';
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
	dependencies: {
		readonly computeManagedVmFingerprint?: (options: {
			readonly buildConfigPath: string;
			readonly fingerprintInput?: unknown;
			readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
		}) => Promise<string>;
	} = {},
): Promise<boolean> {
	const zone = requireZone(systemConfig, zoneId);
	const gatewayImageProfile = systemConfig.imageProfiles.gateways[zone.gateway.imageProfile];
	if (!gatewayImageProfile) {
		throw new Error(`Gateway image profile '${zone.gateway.imageProfile}' is not configured.`);
	}
	const gatewayProfileCacheDirectory = path.join(
		systemConfig.cacheDir,
		'gateway-images',
		zone.gateway.imageProfile,
	);
	const preparedGatewayImage = await readPreparedManagedVmImage({
		buildConfigPath: gatewayImageProfile.buildConfig,
		cacheDir: gatewayProfileCacheDirectory,
	});
	if (preparedGatewayImage === undefined) {
		return false;
	}
	const expectedFingerprint = await (
		dependencies.computeManagedVmFingerprint ??
		(async (options): Promise<string> =>
			await computeFingerprintFromConfigPath(options.buildConfigPath, {
				...(options.fingerprintInput === undefined
					? {}
					: { fingerprintInput: options.fingerprintInput }),
				...(options.managedGatewayBoot === undefined
					? {}
					: { managedGatewayBoot: options.managedGatewayBoot }),
			}))
	)({
		buildConfigPath: gatewayImageProfile.buildConfig,
		...(preparedGatewayImage.fingerprintInput === undefined
			? {}
			: { fingerprintInput: preparedGatewayImage.fingerprintInput }),
		...(preparedGatewayImage.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: preparedGatewayImage.managedGatewayBoot }),
	});
	return preparedGatewayImage.fingerprint === expectedFingerprint;
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
							zoneIds: [selectedZone.id],
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
				description: 'Reconcile exact VM ownership without contacting the controller',
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
					const result = await dependencies.runControllerOfflineCleanup({
						force,
						systemConfig,
						zoneId: selectedZone.id,
					});
					io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				},
			}),
			status: createControllerOperationSubcommand(io, dependencies, {
				description: 'Show controller status',
				name: 'status',
			}),
			health: createControllerOperationSubcommand(io, dependencies, {
				description: 'Run the configured live gateway health probe for a zone',
				name: 'health',
				supportsZone: true,
			}),
			'health-snapshot': createControllerOperationSubcommand(io, dependencies, {
				description: 'Show the latest in-memory health snapshot for a zone',
				name: 'health-snapshot',
				supportsZone: true,
			}),
			'service-health': createControllerOperationSubcommand(io, dependencies, {
				description: 'Run the live gateway service liveness probe for a zone',
				name: 'service-health',
				supportsZone: true,
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
					check: command({
						name: 'check',
						description: 'Check zone credential resolution without refreshing the gateway',
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
								restArguments: appendZoneArgument(['check'], selectedZone.id),
								subcommand: 'credentials',
								systemConfig,
							});
						},
					}),
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
		},
	});
}
