import path from 'node:path';

import type { ManagedVmImageBuildResult } from '@agent-vm/managed-vm';
import { object, or } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import type { ManagedGatewayImageBootProjection } from '../../build/gondolin-managed-vm-build-tooling.js';
import { readPreparedManagedVmImage } from '../../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import { managedGatewayBootProjectionForGatewayType } from '../build-command.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { createRunTask } from '../run-task.js';
import { runSshCommand } from '../ssh-commands.js';
import { cliDescription, createPresenceFlag } from './command-definition-support.js';
import {
	appendZoneArgument,
	createConfigOption,
	createPurgeFlag,
	createZoneOption,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

interface ComputeManagedVmFingerprintOptions {
	readonly buildConfigPath: string;
	readonly fingerprintInput?: unknown;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
}

interface IsGatewayImageCachedDependencies {
	readonly computeManagedVmFingerprint?: (
		options: ComputeManagedVmFingerprintOptions,
	) => Promise<string>;
}

async function resolveExpectedGatewayFingerprint(
	dependencies: IsGatewayImageCachedDependencies,
	options: ComputeManagedVmFingerprintOptions,
): Promise<string | undefined> {
	try {
		const computeManagedVmFingerprint =
			dependencies.computeManagedVmFingerprint ??
			(async (fingerprintOptions: ComputeManagedVmFingerprintOptions): Promise<string> =>
				await computeFingerprintFromConfigPath(fingerprintOptions.buildConfigPath, {
					...(fingerprintOptions.fingerprintInput === undefined
						? {}
						: { fingerprintInput: fingerprintOptions.fingerprintInput }),
					...(fingerprintOptions.managedGatewayBoot === undefined
						? {}
						: { managedGatewayBoot: fingerprintOptions.managedGatewayBoot }),
				}));
		return await computeManagedVmFingerprint(options);
	} catch {
		return undefined;
	}
}

async function resolveCachedGatewayImage(
	systemConfig: LoadedSystemConfig,
	zoneId: string,
	dependencies: IsGatewayImageCachedDependencies = {},
): Promise<ManagedVmImageBuildResult | undefined> {
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
		return undefined;
	}
	const managedGatewayBoot = managedGatewayBootProjectionForGatewayType(zone.gateway.type);
	const expectedFingerprint = await resolveExpectedGatewayFingerprint(dependencies, {
		buildConfigPath: gatewayImageProfile.buildConfig,
		...(preparedGatewayImage.fingerprintInput === undefined
			? {}
			: { fingerprintInput: preparedGatewayImage.fingerprintInput }),
		...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
	});
	if (
		expectedFingerprint === undefined ||
		preparedGatewayImage.fingerprint !== expectedFingerprint
	) {
		return undefined;
	}
	return {
		built: preparedGatewayImage.built,
		fingerprint: preparedGatewayImage.fingerprint,
		imageReference: preparedGatewayImage.imagePath,
	};
}

export async function isGatewayImageCached(
	systemConfig: LoadedSystemConfig,
	zoneId: string,
	dependencies: IsGatewayImageCachedDependencies = {},
): Promise<boolean> {
	return (await resolveCachedGatewayImage(systemConfig, zoneId, dependencies)) !== undefined;
}

async function requireGatewayImageCache(
	systemConfig: LoadedSystemConfig,
	zoneId: string,
	dependencies: Pick<CliDependencies, 'isGatewayImageCached'>,
): Promise<ManagedVmImageBuildResult | undefined> {
	if (dependencies.isGatewayImageCached !== undefined) {
		if (await dependencies.isGatewayImageCached(systemConfig, zoneId)) {
			return undefined;
		}
	} else {
		const preparedImage = await resolveCachedGatewayImage(systemConfig, zoneId);
		if (preparedImage !== undefined) {
			return preparedImage;
		}
	}

	throw new Error(
		`[start] Gateway image not cached. Run \`agent-vm build\` first, then retry \`agent-vm controller start --zone ${zoneId}\`.`,
	);
}

type ControllerOperationName =
	| 'destroy'
	| 'health'
	| 'health-snapshot'
	| 'logs'
	| 'service-health'
	| 'status'
	| 'stop'
	| 'upgrade';

interface ControllerConfigOptions {
	readonly config: string;
	readonly zone?: string | undefined;
	readonly purge?: boolean | undefined;
}

type ControllerZoneOptions = ControllerConfigOptions;

export type ControllerCommand =
	| { readonly command: 'controller.start'; readonly options: ControllerZoneOptions }
	| { readonly command: 'controller.stop'; readonly options: ControllerConfigOptions }
	| {
			readonly command: 'controller.cleanup';
			readonly options: ControllerZoneOptions & { readonly force: boolean };
	  }
	| { readonly command: 'controller.status'; readonly options: ControllerConfigOptions }
	| { readonly command: 'controller.health'; readonly options: ControllerZoneOptions }
	| {
			readonly command: 'controller.health-snapshot';
			readonly options: ControllerZoneOptions;
	  }
	| { readonly command: 'controller.service-health'; readonly options: ControllerZoneOptions }
	| {
			readonly command: 'controller.ssh';
			readonly options: ControllerZoneOptions & { readonly allSecrets: boolean };
	  }
	| {
			readonly command: 'controller.destroy';
			readonly options: ControllerZoneOptions & { readonly purge: boolean };
	  }
	| { readonly command: 'controller.upgrade'; readonly options: ControllerZoneOptions }
	| { readonly command: 'controller.logs'; readonly options: ControllerZoneOptions }
	| {
			readonly command: 'controller.credentials.check';
			readonly options: ControllerZoneOptions;
	  }
	| {
			readonly command: 'controller.credentials.refresh';
			readonly options: ControllerZoneOptions;
	  };

type AnyControllerOperationCommand = {
	readonly command: `controller.${ControllerOperationName}`;
	readonly options: {
		readonly config: string;
		readonly zone?: unknown;
		readonly purge?: unknown;
	};
};

function createControllerOperationParser(
	name: 'stop' | 'status',
	description: string,
): Parser<'sync', Extract<ControllerCommand, { readonly command: `controller.${typeof name}` }>>;
function createControllerOperationParser(
	name: 'health' | 'health-snapshot' | 'service-health' | 'upgrade' | 'logs',
	description: string,
	supportsZone: true,
): Parser<'sync', Extract<ControllerCommand, { readonly command: `controller.${typeof name}` }>>;
function createControllerOperationParser(
	name: 'destroy',
	description: string,
	supportsZone: true,
	supportsPurge: true,
): Parser<'sync', Extract<ControllerCommand, { readonly command: `controller.${typeof name}` }>>;
function createControllerOperationParser(
	name: ControllerOperationName,
	description: string,
	supportsZone = false,
	supportsPurge = false,
): Parser<'sync', AnyControllerOperationCommand> {
	return command(
		name,
		map(
			object({
				config: createConfigOption(),
				...(supportsZone ? { zone: createZoneOption() } : {}),
				...(supportsPurge ? { purge: createPurgeFlag() } : {}),
			}),
			(options) => ({ command: `controller.${name}` as const, options }),
		),
		{ description: cliDescription(description) },
	);
}

export function createControllerSubcommands(): Parser<'sync', ControllerCommand> {
	const start = command(
		'start',
		map(object({ config: createConfigOption(), zone: createZoneOption() }), (options) => ({
			command: 'controller.start' as const,
			options,
		})),
		{ description: cliDescription('Boot the controller and gateway') },
	);
	const cleanup = command(
		'cleanup',
		map(
			object({
				config: createConfigOption(),
				force: createPresenceFlag(
					'--force',
					'Allow cleanup even if the controller health endpoint is reachable',
				),
				zone: createZoneOption(),
			}),
			(options) => ({ command: 'controller.cleanup' as const, options }),
		),
		{
			description: cliDescription('Reconcile exact VM ownership without contacting the controller'),
		},
	);
	const ssh = command(
		'ssh',
		map(
			object({
				allSecrets: createPresenceFlag(
					'--all-secrets',
					'Load every raw gateway environment secret in the SSH shell',
				),
				config: createConfigOption(),
				zone: createZoneOption(),
			}),
			(options) => ({ command: 'controller.ssh' as const, options }),
		),
		{ description: cliDescription('Open an SSH session into the gateway VM') },
	);
	const credentialsCheck = command(
		'check',
		map(object({ config: createConfigOption(), zone: createZoneOption() }), (options) => ({
			command: 'controller.credentials.check' as const,
			options,
		})),
		{
			description: cliDescription(
				'Check zone credential resolution without refreshing the gateway',
			),
		},
	);
	const credentialsRefresh = command(
		'refresh',
		map(object({ config: createConfigOption(), zone: createZoneOption() }), (options) => ({
			command: 'controller.credentials.refresh' as const,
			options,
		})),
		{ description: cliDescription('Refresh zone credentials') },
	);
	const credentials = command('credentials', or(credentialsCheck, credentialsRefresh), {
		description: cliDescription('Manage credentials'),
	});
	return command(
		'controller',
		or(
			start,
			createControllerOperationParser('stop', 'Stop the controller'),
			cleanup,
			createControllerOperationParser('status', 'Show controller status'),
			createControllerOperationParser(
				'health',
				'Run the configured live gateway health probe for a zone',
				true,
			),
			createControllerOperationParser(
				'health-snapshot',
				'Show the latest in-memory health snapshot for a zone',
				true,
			),
			createControllerOperationParser(
				'service-health',
				'Run the live gateway service liveness probe for a zone',
				true,
			),
			ssh,
			createControllerOperationParser('destroy', 'Destroy a zone runtime', true, true),
			createControllerOperationParser('upgrade', 'Upgrade a zone runtime', true),
			createControllerOperationParser('logs', 'Show gateway logs', true),
			credentials,
		),
		{ description: cliDescription('Manage the VM controller') },
	);
}

export async function runControllerCommand(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: ControllerCommand,
): Promise<void> {
	if (commandValue.command === 'controller.start') {
		const systemConfig = await loadSystemConfigFromOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		const prebuiltImage = await requireGatewayImageCache(
			systemConfig,
			selectedZone.id,
			dependencies,
		);
		const runTask = await createRunTask(io);
		const runtime = await dependencies.startControllerRuntime(
			{
				...(prebuiltImage === undefined
					? {}
					: { prebuiltGatewayImages: { [selectedZone.id]: prebuiltImage } }),
				systemConfig,
				zoneIds: [selectedZone.id],
			},
			{ runTask },
		);
		const startedZone = runtime.zones.find((runtimeZone) => runtimeZone.zoneId === selectedZone.id);
		io.stdout.write(
			`${JSON.stringify({ controllerPort: runtime.controllerPort, ingress: startedZone?.gateway?.ingress ?? null, vmId: startedZone?.gateway?.vm.id ?? null, zoneId: selectedZone.id }, null, 2)}\n`,
		);
		return;
	}
	if (commandValue.command === 'controller.cleanup') {
		const systemConfig = await loadSystemConfigFromOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		const result = await dependencies.runControllerOfflineCleanup({
			force: commandValue.options.force,
			systemConfig,
			zoneId: selectedZone.id,
		});
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	if (commandValue.command === 'controller.ssh') {
		const systemConfig = await loadSystemConfigFromOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		await runSshCommand({
			dependencies,
			io,
			restArguments: [
				'--zone',
				selectedZone.id,
				...(commandValue.options.allSecrets ? ['--all-secrets'] : []),
			],
			systemConfig,
		});
		return;
	}
	if (
		commandValue.command === 'controller.credentials.check' ||
		commandValue.command === 'controller.credentials.refresh'
	) {
		const systemConfig = await loadSystemConfigFromOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		const action = commandValue.command.endsWith('.check') ? 'check' : 'refresh';
		await runControllerOperationCommand({
			dependencies,
			io,
			restArguments: appendZoneArgument([action], selectedZone.id),
			subcommand: 'credentials',
			systemConfig,
		});
		return;
	}
	const systemConfig = await loadSystemConfigFromOption(commandValue.options.config, dependencies);
	const supportsZone =
		commandValue.command === 'controller.health' ||
		commandValue.command === 'controller.health-snapshot' ||
		commandValue.command === 'controller.service-health' ||
		commandValue.command === 'controller.destroy' ||
		commandValue.command === 'controller.upgrade' ||
		commandValue.command === 'controller.logs';
	const zoneFlag =
		supportsZone && 'zone' in commandValue.options && typeof commandValue.options.zone === 'string'
			? commandValue.options.zone
			: undefined;
	const selectedZone = supportsZone ? requireZone(systemConfig, zoneFlag) : undefined;
	const operationName: ControllerOperationName =
		commandValue.command === 'controller.health'
			? 'health'
			: commandValue.command === 'controller.health-snapshot'
				? 'health-snapshot'
				: commandValue.command === 'controller.service-health'
					? 'service-health'
					: commandValue.command === 'controller.destroy'
						? 'destroy'
						: commandValue.command === 'controller.upgrade'
							? 'upgrade'
							: commandValue.command === 'controller.logs'
								? 'logs'
								: commandValue.command === 'controller.stop'
									? 'stop'
									: 'status';
	const prefix =
		commandValue.command === 'controller.destroy' &&
		'purge' in commandValue.options &&
		commandValue.options.purge
			? ['--purge']
			: [];
	await runControllerOperationCommand({
		dependencies,
		io,
		restArguments: selectedZone ? appendZoneArgument(prefix, selectedZone.id) : prefix,
		subcommand: operationName,
		systemConfig,
	});
}
