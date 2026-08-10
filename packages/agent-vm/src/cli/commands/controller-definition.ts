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
import type { ControllerRuntime } from '../../controller/controller-runtime-types.js';
import { createObservabilityRuntimeConfig } from '../../observability/observability-config.js';
import {
	configureProcessLogging,
	type ProcessLoggingHandle,
	type ProcessLoggingOptions,
} from '../../observability/process-logging.js';
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
}

interface ControllerZoneOptions extends ControllerConfigOptions {
	readonly zone: string | undefined;
}

interface ControllerDestroyOptions extends ControllerZoneOptions {
	readonly purge: boolean;
}

type ControllerOperationOptionsByName = {
	readonly destroy: ControllerDestroyOptions;
	readonly health: ControllerZoneOptions;
	readonly 'health-snapshot': ControllerZoneOptions;
	readonly logs: ControllerZoneOptions;
	readonly 'service-health': ControllerZoneOptions;
	readonly status: ControllerConfigOptions;
	readonly stop: ControllerConfigOptions;
	readonly upgrade: ControllerZoneOptions;
};

type ControllerOperationCommandFor<TName extends ControllerOperationName> = {
	readonly command: `controller.${TName}`;
	readonly options: ControllerOperationOptionsByName[TName];
};

type ControllerOperationCommand = {
	[TName in ControllerOperationName]: ControllerOperationCommandFor<TName>;
}[ControllerOperationName];

export type ControllerCommand =
	| { readonly command: 'controller.start'; readonly options: ControllerZoneOptions }
	| {
			readonly command: 'controller.cleanup';
			readonly options: ControllerZoneOptions & { readonly force: boolean };
	  }
	| {
			readonly command: 'controller.ssh';
			readonly options: ControllerZoneOptions & { readonly allSecrets: boolean };
	  }
	| {
			readonly command: 'controller.credentials.check';
			readonly options: ControllerZoneOptions;
	  }
	| {
			readonly command: 'controller.credentials.refresh';
			readonly options: ControllerZoneOptions;
	  }
	| ControllerOperationCommand;

export interface ControllerStartExecutionOptions {
	readonly configureProcessLogging?:
		| ((options: ProcessLoggingOptions) => Promise<ProcessLoggingHandle>)
		| undefined;
	readonly processRoot?: boolean;
	readonly processLoggingStderr?: NodeJS.WritableStream;
}

export interface ControllerStartLifecycleOptions {
	readonly createShutdownSignalWaiter?: () => ProcessShutdownSignalWaiter;
	readonly io: CliIo;
	readonly logging: ProcessLoggingHandle;
	readonly runtime: ControllerRuntime;
	readonly selectedZoneId: string;
	readonly waitForShutdownSignal?: () => Promise<void>;
}

export interface ProcessShutdownSignalWaiter {
	readonly signal: Promise<void>;
	readonly cleanup: () => void;
}

function isNodeWritableStream(value: CliIo['stderr']): value is NodeJS.WritableStream {
	return (
		typeof value === 'object' &&
		value !== null &&
		'writable' in value &&
		typeof value.writable === 'boolean' &&
		'end' in value &&
		typeof value.end === 'function' &&
		'on' in value &&
		typeof value.on === 'function'
	);
}

export function resolveControllerProcessLoggingStderr(
	io: CliIo,
	executionOptions: ControllerStartExecutionOptions,
): NodeJS.WritableStream {
	return (
		executionOptions.processLoggingStderr ??
		(isNodeWritableStream(io.stderr) ? io.stderr : process.stderr)
	);
}

export function createProcessShutdownSignalWaiter(): ProcessShutdownSignalWaiter {
	let resolveSignal: (() => void) | undefined;
	let signaled = false;
	let cleanedUp = false;
	const signal = new Promise<void>((resolve) => {
		resolveSignal = resolve;
	});
	const onSignal = (): void => {
		if (signaled) {
			return;
		}
		signaled = true;
		resolveSignal?.();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	return {
		signal,
		cleanup: (): void => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
		},
	};
}

export function waitForProcessShutdownSignal(): Promise<void> {
	const waiter = createProcessShutdownSignalWaiter();
	return waiter.signal.finally(waiter.cleanup);
}

function writeControllerStartReadiness(
	io: CliIo,
	runtime: ControllerRuntime,
	selectedZoneId: string,
): void {
	const startedZone = runtime.zones.find((runtimeZone) => runtimeZone.zoneId === selectedZoneId);
	io.stdout.write(
		`${JSON.stringify({ controllerPort: runtime.controllerPort, ingress: startedZone?.gateway?.ingress ?? null, vmId: startedZone?.gateway?.vm.id ?? null, zoneId: selectedZoneId }, null, 2)}\n`,
	);
}

async function reportSecondaryLoggingShutdownFailure(io: CliIo): Promise<void> {
	try {
		io.stderr.write('Controller process logging shutdown failed.\n');
	} catch {
		// The product result remains authoritative when stderr itself is unavailable.
	}
}

export async function runControllerStartLifecycle(
	options: ControllerStartLifecycleOptions,
): Promise<void> {
	writeControllerStartReadiness(options.io, options.runtime, options.selectedZoneId);
	const shutdownSignalWaiter =
		options.waitForShutdownSignal === undefined
			? (options.createShutdownSignalWaiter ?? createProcessShutdownSignalWaiter)()
			: {
					signal: options.waitForShutdownSignal(),
					cleanup: (): void => undefined,
				};

	let closePromise: Promise<void> | undefined;
	const closeRuntime = (): Promise<void> => {
		closePromise ??= options.runtime.close();
		return closePromise;
	};
	let productCloseError: unknown;
	try {
		await shutdownSignalWaiter.signal;
		try {
			await closeRuntime();
		} catch (error) {
			productCloseError = error;
		}
		try {
			await options.logging.shutdown();
		} catch {
			await reportSecondaryLoggingShutdownFailure(options.io);
		}
		if (productCloseError !== undefined) {
			throw productCloseError;
		}
	} finally {
		shutdownSignalWaiter.cleanup();
	}
}

function createControllerOperationParser<TName extends ControllerOperationName>(
	name: TName,
	description: string,
	optionsParser: Parser<'sync', ControllerOperationOptionsByName[TName]>,
): Parser<'sync', ControllerOperationCommandFor<TName>> {
	return command(
		name,
		map(optionsParser, (options) => ({ command: `controller.${name}` as const, options })),
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
			createControllerOperationParser(
				'stop',
				'Stop the controller',
				object({ config: createConfigOption() }),
			),
			cleanup,
			createControllerOperationParser(
				'status',
				'Show controller status',
				object({ config: createConfigOption() }),
			),
			createControllerOperationParser(
				'health',
				'Run the configured live gateway health probe for a zone',
				object({ config: createConfigOption(), zone: createZoneOption() }),
			),
			createControllerOperationParser(
				'health-snapshot',
				'Show the latest in-memory health snapshot for a zone',
				object({ config: createConfigOption(), zone: createZoneOption() }),
			),
			createControllerOperationParser(
				'service-health',
				'Run the live gateway service liveness probe for a zone',
				object({ config: createConfigOption(), zone: createZoneOption() }),
			),
			ssh,
			createControllerOperationParser(
				'destroy',
				'Destroy a zone runtime',
				object({
					config: createConfigOption(),
					purge: createPurgeFlag(),
					zone: createZoneOption(),
				}),
			),
			createControllerOperationParser(
				'upgrade',
				'Upgrade a zone runtime',
				object({ config: createConfigOption(), zone: createZoneOption() }),
			),
			createControllerOperationParser(
				'logs',
				'Show gateway logs',
				object({ config: createConfigOption(), zone: createZoneOption() }),
			),
			credentials,
		),
		{ description: cliDescription('Manage the VM controller') },
	);
}

export async function runControllerCommand(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: ControllerCommand,
	executionOptions: ControllerStartExecutionOptions = {},
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
		const processLoggingConfig = createObservabilityRuntimeConfig(systemConfig);
		if (!executionOptions.processRoot) {
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
			writeControllerStartReadiness(io, runtime, selectedZone.id);
			return;
		}
		let logging: ProcessLoggingHandle;
		try {
			const configureLogging = executionOptions.configureProcessLogging ?? configureProcessLogging;
			logging = await configureLogging({
				observabilityConfig: processLoggingConfig,
				serviceName: 'agent-vm-controller',
				stderr: resolveControllerProcessLoggingStderr(io, executionOptions),
			});
		} catch {
			throw new Error('Controller process logging setup failed.');
		}
		let runtimeStarted = false;
		try {
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
			runtimeStarted = true;
			await runControllerStartLifecycle({
				io,
				logging,
				runtime,
				selectedZoneId: selectedZone.id,
			});
		} catch (error) {
			if (!runtimeStarted) {
				try {
					await logging.shutdown();
				} catch {
					await reportSecondaryLoggingShutdownFailure(io);
				}
			}
			throw error;
		}
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
	const selectedZone =
		'zone' in commandValue.options
			? requireZone(systemConfig, commandValue.options.zone)
			: undefined;
	const operationName: ControllerOperationName = (() => {
		switch (commandValue.command) {
			case 'controller.destroy':
				return 'destroy';
			case 'controller.health':
				return 'health';
			case 'controller.health-snapshot':
				return 'health-snapshot';
			case 'controller.logs':
				return 'logs';
			case 'controller.service-health':
				return 'service-health';
			case 'controller.status':
				return 'status';
			case 'controller.stop':
				return 'stop';
			case 'controller.upgrade':
				return 'upgrade';
			default: {
				const unreachableCommand: never = commandValue;
				throw new Error(`Unhandled controller command: ${String(unreachableCommand)}`);
			}
		}
	})();
	const prefix =
		commandValue.command === 'controller.destroy' && commandValue.options.purge ? ['--purge'] : [];
	await runControllerOperationCommand({
		dependencies,
		io,
		restArguments: selectedZone ? appendZoneArgument(prefix, selectedZone.id) : prefix,
		subcommand: operationName,
		systemConfig,
	});
}
