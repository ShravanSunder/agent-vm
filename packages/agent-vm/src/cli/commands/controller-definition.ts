// oxlint-disable typescript-eslint/explicit-function-return-type
import fs from 'node:fs';
import path from 'node:path';

import { command, positional, string, subcommands } from 'cmd-ts';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { runLeaseCommand } from '../lease-commands.js';
import { createRunTask } from '../run-task.js';
import { runSshCommand } from '../ssh-commands.js';
import {
	appendZoneArgument,
	createConfigOption,
	createPurgeFlag,
	createPrintFlag,
	createRemoteCommandArguments,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

function createControllerOperationSubcommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: {
		readonly name: 'destroy' | 'logs' | 'start' | 'status' | 'stop' | 'upgrade';
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
			const restArguments = appendZoneArgument(
				options.supportsPurge && 'purge' in rest && rest.purge ? ['--purge'] : [],
				'zone' in rest ? (rest.zone as string | undefined) : undefined,
			);
			await runControllerOperationCommand({
				dependencies,
				io,
				restArguments,
				subcommand: options.name,
				systemConfig: loadSystemConfigFromOption(config, dependencies),
			});
		},
	});
}

async function warnIfGatewayImageCacheIsCold(
	io: CliIo,
	systemConfig: ReturnType<typeof loadSystemConfigFromOption>,
): Promise<void> {
	const gatewayFingerprint = await computeFingerprintFromConfigPath(
		systemConfig.images.gateway.buildConfig,
	);
	const gatewayCachePath = path.join(
		systemConfig.cacheDir,
		'images',
		'gateway',
		gatewayFingerprint,
	);
	if (!fs.existsSync(path.join(gatewayCachePath, 'manifest.json'))) {
		io.stderr.write(
			'[start] Gateway image not cached. Run `agent-vm build` first for faster startup.\n',
		);
		io.stderr.write('[start] Building inline...\n');
	}
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
				},
				handler: async ({ config }) => {
					const systemConfig = loadSystemConfigFromOption(config, dependencies);
					if (systemConfig.zones.length !== 1) {
						throw new Error(
							`controller start currently supports a single-zone system.json, but found ${systemConfig.zones.length} zones. Split the config or add explicit multi-zone runtime support before starting.`,
						);
					}
					const firstZone = systemConfig.zones[0];
					if (!firstZone) {
						throw new Error('System config does not define any zones.');
					}

					await warnIfGatewayImageCacheIsCold(io, systemConfig);
					const runTask = await createRunTask(io);
					const runtime = await dependencies.startControllerRuntime(
						{
							systemConfig,
							zoneId: firstZone.id,
						},
						{ runTask },
					);
					io.stdout.write(
						`${JSON.stringify(
							{
								controllerPort: runtime.controllerPort,
								ingress: runtime.gateway.ingress,
								vmId: runtime.gateway.vm.id,
								zoneId: firstZone.id,
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
			status: createControllerOperationSubcommand(io, dependencies, {
				description: 'Show controller status',
				name: 'status',
			}),
			ssh: command({
				name: 'ssh',
				description: 'Open an SSH session into the gateway VM',
				args: {
					config: createConfigOption(),
					print: createPrintFlag(),
					remoteCommandArguments: createRemoteCommandArguments(),
					zone: createZoneOption(),
				},
				handler: async ({ config, print, remoteCommandArguments, zone }) => {
					const restArguments = [
						...(zone ? ['--zone', zone] : []),
						...(print ? ['--print'] : []),
						...(remoteCommandArguments.length > 0 ? ['--', ...remoteCommandArguments] : []),
					];
					await runSshCommand({
						dependencies,
						io,
						restArguments,
						systemConfig: loadSystemConfigFromOption(config, dependencies),
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
							await runControllerOperationCommand({
								dependencies,
								io,
								restArguments: appendZoneArgument(['refresh'], zone),
								subcommand: 'credentials',
								systemConfig: loadSystemConfigFromOption(config, dependencies),
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
								systemConfig: loadSystemConfigFromOption(config, dependencies),
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
								systemConfig: loadSystemConfigFromOption(config, dependencies),
							});
						},
					}),
				},
			}),
		},
	});
}
