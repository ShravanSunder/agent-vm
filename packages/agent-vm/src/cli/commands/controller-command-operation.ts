import path from 'node:path';

import type { ManagedVmImageBuildResult } from '@agent-vm/managed-vm';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import type { ManagedGatewayImageBootProjection } from '../../build/gondolin-managed-vm-build-tooling.js';
import { readPreparedManagedVmImage } from '../../build/prepared-gondolin-image-cache.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import type { AgentVmCommand } from '../agent-vm-command-parser.js';
import { managedGatewayBootProjectionForGatewayType } from '../build-command.js';
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

export async function runControllerCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	commandValue: ControllerCommand,
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
		const systemConfig = await loadSystemConfigFromCliOption(
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
		const systemConfig = await loadSystemConfigFromCliOption(
			commandValue.options.config,
			dependencies,
		);
		const selectedZone = requireZone(systemConfig, commandValue.options.zone);
		await runSshCommand({
			dependencies,
			io,
			allSecrets: commandValue.options.allSecrets,
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
