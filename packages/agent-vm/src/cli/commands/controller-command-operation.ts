import path from 'node:path';

import type { ManagedVmImageBuildResult } from '@agent-vm/managed-vm';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import type { ManagedGatewayImageBootProjection } from '../../build/gondolin-managed-vm-build-tooling.js';
import { readPreparedManagedVmImage } from '../../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';
import type { ControllerRuntime } from '../../controller/controller-runtime-types.js';
import { resolveControllerTelemetryIdentity } from '../../observability/controller-telemetry-identity.js';
import { createControllerTelemetryResourceAttributes } from '../../observability/controller-telemetry.js';
import { createObservabilityRuntimeConfig } from '../../observability/observability-config.js';
import {
	configureProcessLogging,
	type ProcessLoggingHandle,
	type ProcessLoggingOptions,
} from '../../observability/process-logging.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import type { AgentVmCommand } from '../agent-vm-command-parser.js';
import { managedGatewayBootProjectionForGatewayType } from '../build-command.js';
import { resolveCliVersion } from '../cli-version.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { createRunTask } from '../run-task.js';
import { runSshCommand } from '../ssh-commands.js';
import { loadSystemConfigFromCliOption } from './command-operation-support.js';

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

type ControllerCommand = Extract<AgentVmCommand, { readonly command: `controller.${string}` }>;
type ControllerOperationName =
	| 'destroy'
	| 'health'
	| 'health-snapshot'
	| 'logs'
	| 'service-health'
	| 'status'
	| 'stop'
	| 'upgrade';

export interface ControllerCommandExecutionOptions {
	readonly configureProcessLogging?:
		| ((options: ProcessLoggingOptions) => Promise<ProcessLoggingHandle>)
		| undefined;
	readonly createShutdownSignalWaiter?: (() => ProcessShutdownSignalWaiter) | undefined;
	readonly processLoggingStderr?: NodeJS.WritableStream | undefined;
	readonly processRoot?: boolean | undefined;
	readonly resolveControllerTelemetryIdentity?:
		| typeof resolveControllerTelemetryIdentity
		| undefined;
}

export interface ProcessShutdownSignalWaiter {
	readonly cleanup: () => void;
	readonly signal: Promise<void>;
}

export interface ProcessShutdownSignalTarget {
	readonly off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
	readonly on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
}

export function createProcessShutdownSignalWaiter(
	target: ProcessShutdownSignalTarget = process,
): ProcessShutdownSignalWaiter {
	let resolveSignal: (() => void) | undefined;
	let observed = false;
	const signal = new Promise<void>((resolve) => {
		resolveSignal = resolve;
	});
	const onSignal = (): void => {
		if (observed) return;
		observed = true;
		resolveSignal?.();
	};
	target.on('SIGINT', onSignal);
	target.on('SIGTERM', onSignal);
	return {
		cleanup: (): void => {
			target.off('SIGINT', onSignal);
			target.off('SIGTERM', onSignal);
		},
		signal,
	};
}

function writeControllerReadiness(
	io: CliIo,
	runtime: ControllerRuntime,
	selectedZoneId: string,
): void {
	const startedZone = runtime.zones.find((runtimeZone) => runtimeZone.zoneId === selectedZoneId);
	io.stdout.write(
		`${JSON.stringify({ controllerPort: runtime.controllerPort, ingress: startedZone?.gateway?.ingress ?? null, vmId: startedZone?.gateway?.vm.id ?? null, zoneId: selectedZoneId }, null, 2)}\n`,
	);
}

function writeSecondaryLoggingFailure(io: CliIo, message: string): void {
	try {
		io.stderr.write(message);
	} catch {
		// Product results remain authoritative when the diagnostic writer is unavailable.
	}
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

function resolveProcessLoggingStderr(
	io: CliIo,
	executionOptions: ControllerCommandExecutionOptions,
): NodeJS.WritableStream {
	if (executionOptions.processLoggingStderr !== undefined) {
		return executionOptions.processLoggingStderr;
	}
	const stderr = io.stderr;
	if (isNodeWritableStream(stderr)) return stderr;
	return process.stderr;
}

async function configureControllerLogging(
	io: CliIo,
	systemConfig: LoadedSystemConfig,
	dependencies: CliDependencies,
	executionOptions: ControllerCommandExecutionOptions,
): Promise<ProcessLoggingHandle> {
	try {
		const observabilityConfig = createObservabilityRuntimeConfig(systemConfig);
		let resourceAttributes:
			| ReturnType<typeof createControllerTelemetryResourceAttributes>
			| undefined;
		if (observabilityConfig.enabled) {
			const serviceVersion = await (dependencies.resolveCliVersion ?? resolveCliVersion)();
			const identity = await (
				executionOptions.resolveControllerTelemetryIdentity ?? resolveControllerTelemetryIdentity
			)({
				cwd: path.resolve(path.dirname(systemConfig.systemConfigPath), '..'),
				serviceVersion,
			});
			resourceAttributes = createControllerTelemetryResourceAttributes({
				identity,
				projectNamespace: systemConfig.host.projectNamespace,
				stackMode: observabilityConfig.stackMode,
			});
		}
		return await (executionOptions.configureProcessLogging ?? configureProcessLogging)({
			observabilityConfig,
			...(resourceAttributes === undefined ? {} : { resourceAttributes }),
			serviceName: 'agent-vm-controller',
			stderr: resolveProcessLoggingStderr(io, executionOptions),
		});
	} catch (error: unknown) {
		throw new Error('Controller process logging setup failed.', { cause: error });
	}
}

export async function runControllerStartProcessLifecycle(options: {
	readonly io: CliIo;
	readonly logging: ProcessLoggingHandle;
	readonly runtime: ControllerRuntime;
	readonly selectedZoneId: string;
	readonly shutdownSignalWaiter: ProcessShutdownSignalWaiter;
}): Promise<void> {
	let productCloseError: unknown;
	try {
		try {
			writeControllerReadiness(options.io, options.runtime, options.selectedZoneId);
			await options.shutdownSignalWaiter.signal;
		} catch (error: unknown) {
			productCloseError = error;
		}
		try {
			await options.runtime.close();
		} catch (error: unknown) {
			productCloseError ??= error;
		}
		try {
			await options.logging.shutdown();
		} catch {
			writeSecondaryLoggingFailure(options.io, 'Controller process logging shutdown failed.\n');
		}
		if (productCloseError !== undefined) throw productCloseError;
	} finally {
		options.shutdownSignalWaiter.cleanup();
	}
}

export async function runControllerCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: ControllerCommand,
	executionOptions: ControllerCommandExecutionOptions = {},
): Promise<void> {
	if (commandValue.command === 'controller.start') {
		const systemConfig = await loadSystemConfigFromCliOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		const prebuiltImage = await requireGatewayImageCache(
			systemConfig,
			selectedZone.id,
			dependencies,
		);
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
			writeControllerReadiness(io, runtime, selectedZone.id);
			return;
		}
		const logging = await configureControllerLogging(
			io,
			systemConfig,
			dependencies,
			executionOptions,
		);
		const shutdownSignalWaiter = (
			executionOptions.createShutdownSignalWaiter ?? createProcessShutdownSignalWaiter
		)();
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
			await runControllerStartProcessLifecycle({
				io,
				logging,
				runtime,
				selectedZoneId: selectedZone.id,
				shutdownSignalWaiter,
			});
		} catch (error: unknown) {
			if (!runtimeStarted) {
				shutdownSignalWaiter.cleanup();
				try {
					await logging.shutdown();
				} catch {
					writeSecondaryLoggingFailure(io, 'Controller process logging shutdown failed.\n');
				}
			}
			throw error;
		}
		return;
	}
	if (commandValue.command === 'controller.credential-runtime.retire') {
		const systemConfig = await loadSystemConfigFromCliOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		await runControllerOperationCommand({
			credentialRuntimeRetirement: {
				agentId: commandValue.options.agent,
				force: commandValue.options.force,
			},
			dependencies,
			io,
			subcommand: 'credential-runtime-retire',
			systemConfig,
			zoneId: selectedZone.id,
		});
		return;
	}
	if (commandValue.command === 'controller.cleanup') {
		const systemConfig = await loadSystemConfigFromCliOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		const logging = executionOptions.processRoot
			? await configureControllerLogging(io, systemConfig, dependencies, executionOptions)
			: undefined;
		try {
			const result = await dependencies.runControllerOfflineCleanup({
				force: commandValue.options.force,
				systemConfig,
				zoneId: selectedZone.id,
			});
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} finally {
			if (logging !== undefined) {
				try {
					await logging.shutdown();
				} catch {
					writeSecondaryLoggingFailure(io, 'Controller process logging shutdown failed.\n');
				}
			}
		}
		return;
	}
	if (commandValue.command === 'controller.ssh') {
		const systemConfig = await loadSystemConfigFromCliOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		await runSshCommand({
			dependencies,
			io,
			zoneId: selectedZone.id,
			systemConfig,
		});
		return;
	}
	if (
		commandValue.command === 'controller.credentials.check' ||
		commandValue.command === 'controller.credentials.refresh'
	) {
		const systemConfig = await loadSystemConfigFromCliOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		const action = commandValue.command.endsWith('.check') ? 'check' : 'refresh';
		await runControllerOperationCommand({
			dependencies,
			io,
			credentialsAction: action,
			zoneId: selectedZone.id,
			subcommand: 'credentials',
			systemConfig,
		});
		return;
	}
	const systemConfig = await loadSystemConfigFromCliOption(
		commandValue.options.config,
		dependencies,
	);
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
	await runControllerOperationCommand({
		dependencies,
		io,
		...(selectedZone === undefined ? {} : { zoneId: selectedZone.id }),
		...(commandValue.command === 'controller.destroy' ? { purge: commandValue.options.purge } : {}),
		subcommand: operationName,
		systemConfig,
	});
}
