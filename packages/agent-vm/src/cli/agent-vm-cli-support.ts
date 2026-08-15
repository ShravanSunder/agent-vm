import {
	createSecretResolver,
	probeOnePasswordServiceAccountHeadlessAuth,
	type SecretResolver,
	resolveServiceAccountToken,
} from '@agent-vm/secret-management';

import { createAgeBackupEncryption } from '../backup/backup-encryption.js';
import { createZoneBackupManager } from '../backup/backup-manager.js';
import { resolveManagedVmMinimumZigVersion } from '../build/managed-vm-build-tooling.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import {
	loadSystemConfig,
	type LoadedSystemConfig,
	type SystemConfig,
} from '../config/system-config.js';
import { createSecretResolver as createControllerSecretResolver } from '../controller/controller-runtime-support.js';
import type {
	ControllerRuntime,
	ControllerRuntimeDependencies,
	StartControllerRuntimeOptions,
} from '../controller/controller-runtime-types.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { createControllerClient } from '../controller/http/controller-client.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { runConfigValidation } from '../operations/config-validation.js';
import { runControllerOfflineCleanup } from '../operations/controller-offline-cleanup.js';
import { buildControllerStatus } from '../operations/controller-status.js';
import {
	type ControllerDoctorResult,
	type DoctorCheck,
	type RunControllerDoctorOptions,
	runControllerDoctor,
} from '../operations/doctor.js';
import { runBuildCommand } from './build-command.js';
import { runCacheCommand } from './cache-commands.js';
import { resolveCliVersion } from './cli-version.js';
import { resetWorkerInstructions } from './config-commands.js';
import type {
	CollectDynamicDoctorChecksOptions,
	ControllerDoctorEnvironment,
} from './controller-operation-commands.js';
import {
	scaffoldAgentVmProject,
	type ScaffoldAgentVmProjectOptions,
	type ScaffoldAgentVmProjectResult,
} from './init-command.js';
import { storeServiceAccountToken } from './keychain-credential.js';
import { updateAgentVmManual, type UpdateAgentVmManualResult } from './manual-commands.js';
import {
	initRepoResources,
	updateRepoResources,
	validateRepoResources,
	type InitRepoResourcesResult,
	type UpdateRepoResourcesResult,
	type ValidateRepoResourcesResult,
} from './resources-commands.js';

export interface CliDependencies {
	readonly buildControllerStatus: typeof buildControllerStatus;
	readonly createAgeBackupEncryption: typeof createAgeBackupEncryption;
	readonly createControllerClient: typeof createControllerClient;
	readonly createSecretResolver: typeof createSecretResolver;
	readonly createZoneBackupManager: typeof createZoneBackupManager;
	readonly collectControllerDoctorEnvironment?: (
		systemConfig: LoadedSystemConfig,
		dependencies: CliDependencies,
	) => Promise<ControllerDoctorEnvironment>;
	readonly collectDynamicDoctorChecks?: (
		options: CollectDynamicDoctorChecksOptions,
	) => Promise<readonly DoctorCheck[]>;
	readonly getCurrentWorkingDirectory?: () => string;
	readonly initRepoResources?: (options: {
		readonly targetDir: string;
	}) => Promise<InitRepoResourcesResult>;
	readonly updateRepoResources?: (options: {
		readonly targetDir: string;
	}) => Promise<UpdateRepoResourcesResult>;
	readonly updateAgentVmManual?: (options: {
		readonly defaultZoneId: string;
		readonly systemConfigPath: string;
		readonly targetDir: string;
		readonly updateAgentIndex: boolean;
	}) => Promise<UpdateAgentVmManualResult>;
	readonly validateRepoResources?: (options: {
		readonly targetDir: string;
	}) => Promise<ValidateRepoResourcesResult>;
	readonly isGatewayImageCached?: (
		systemConfig: LoadedSystemConfig,
		zoneId: string,
	) => Promise<boolean>;
	readonly loadSystemConfig: (configPath: string) => Promise<LoadedSystemConfig>;
	readonly runBuildCommand?: typeof runBuildCommand;
	readonly runCacheCommand?: typeof runCacheCommand;
	readonly runCommand?: (
		command: string,
		arguments_: readonly string[],
	) => Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>;
	readonly runInteractiveProcess?: (
		command: string,
		arguments_: readonly string[],
	) => Promise<void>;
	readonly resolveServiceAccountToken: typeof resolveServiceAccountToken;
	readonly resolveManagedVmMinimumZigVersion: typeof resolveManagedVmMinimumZigVersion;
	readonly runControllerDoctor: (
		options: RunControllerDoctorOptions,
	) => ControllerDoctorResult | Promise<ControllerDoctorResult>;
	readonly runControllerOfflineCleanup: (
		options: Parameters<typeof runControllerOfflineCleanup>[0],
	) => ReturnType<typeof runControllerOfflineCleanup>;
	readonly runConfigValidation?: typeof runConfigValidation;
	readonly promptAndStoreServiceAccountToken?: (options?: {
		readonly account?: string;
		readonly accountName?: string;
		readonly service?: string;
	}) => Promise<boolean>;
	readonly probeOnePasswordServiceAccountHeadlessAuth: typeof probeOnePasswordServiceAccountHeadlessAuth;
	readonly resetWorkerInstructions?: typeof resetWorkerInstructions;
	readonly resolveCliVersion?: typeof resolveCliVersion;
	readonly scaffoldAgentVmProject?: (
		options: ScaffoldAgentVmProjectOptions,
	) => Promise<ScaffoldAgentVmProjectResult>;
	readonly storeServiceAccountToken?: typeof storeServiceAccountToken;
	readonly startControllerRuntime: (
		options: StartControllerRuntimeOptions,
		runtimeDependencies?: Omit<
			ControllerRuntimeDependencies,
			| 'configureManagedVmHostNetworkDefaults'
			| 'managedVmFactory'
			| 'managedVmExactProcessTermination'
			| 'managedVmImages'
			| 'managedVmOwnedDirectories'
		>,
	) => Promise<ControllerRuntime>;
	readonly startGatewayZone: typeof startGatewayZone;
}

export interface CliIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

export const defaultCliDependencies: CliDependencies = {
	buildControllerStatus,
	createAgeBackupEncryption,
	createControllerClient,
	createSecretResolver,
	createZoneBackupManager,
	getCurrentWorkingDirectory: () => process.cwd(),
	loadSystemConfig,
	runBuildCommand,
	runCacheCommand,
	probeOnePasswordServiceAccountHeadlessAuth,
	resolveManagedVmMinimumZigVersion: resolveManagedVmMinimumZigVersion,
	resolveServiceAccountToken,
	runControllerDoctor,
	runControllerOfflineCleanup: async (options) => {
		const managedVmRuntime = createManagedVmRuntimeComposition();
		return await runControllerOfflineCleanup(options, {
			exactProcessTermination: managedVmRuntime.managedVmExactProcessTermination,
		});
	},
	runConfigValidation,
	resetWorkerInstructions,
	resolveCliVersion,
	scaffoldAgentVmProject,
	storeServiceAccountToken,
	updateAgentVmManual,
	initRepoResources,
	updateRepoResources,
	validateRepoResources,
	startControllerRuntime: async (runtimeOptions, runtimeDependencies) => {
		const managedVmRuntime = createManagedVmRuntimeComposition();
		return await startControllerRuntime(runtimeOptions, {
			...runtimeDependencies,
			configureManagedVmHostNetworkDefaults: managedVmRuntime.configureManagedVmHostNetworkDefaults,
			managedVmFactory: managedVmRuntime.managedVmFactory,
			managedVmExactProcessTermination: managedVmRuntime.managedVmExactProcessTermination,
			managedVmImages: managedVmRuntime.managedVmImages,
			managedVmOwnedDirectories: managedVmRuntime.managedVmOwnedDirectories,
		});
	},
	startGatewayZone,
};

export function writeJson(io: CliIo, value: unknown): void {
	io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function resolveControllerBaseUrl(systemConfig: SystemConfig): string {
	return `http://127.0.0.1:${systemConfig.host.controllerPort}`;
}

export function findZone(
	systemConfig: SystemConfig,
	zoneId: string,
): SystemConfig['zones'][number] {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}
	return zone;
}

export function requireZone(
	systemConfig: SystemConfig,
	zoneFlag: string | undefined,
): SystemConfig['zones'][number] {
	if (zoneFlag) {
		return findZone(systemConfig, zoneFlag);
	}

	const zoneList = systemConfig.zones
		.map((zone) => `  --zone ${zone.id}  (${zone.gateway.type})`)
		.join('\n');
	throw new Error(`--zone is required. Available zones:\n${zoneList}`);
}

export async function createResolverFromSystemConfig(
	systemConfig: SystemConfig,
	dependencies: Pick<CliDependencies, 'createSecretResolver' | 'resolveServiceAccountToken'>,
): Promise<SecretResolver> {
	return await createControllerSecretResolver(
		systemConfig,
		dependencies.createSecretResolver,
		dependencies.resolveServiceAccountToken,
	);
}
