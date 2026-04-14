import type { SecretResolver } from '@shravansunder/gondolin-core';
import {
	createOpCliSecretResolver,
	resolveServiceAccountToken,
} from '@shravansunder/gondolin-core';

import { createAgeBackupEncryption } from '../backup/backup-encryption.js';
import { createZoneBackupManager } from '../backup/backup-manager.js';
import { loadSystemConfig, type SystemConfig } from '../config/system-config.js';
import { createSecretResolver as createControllerSecretResolver } from '../controller/controller-runtime-support.js';
import type { ControllerRuntimeDependencies } from '../controller/controller-runtime-types.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { createControllerClient } from '../controller/http/controller-client.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { buildControllerStatus } from '../operations/controller-status.js';
import { runControllerDoctor } from '../operations/doctor.js';
import { runBuildCommand } from './build-command.js';
import { runCacheCommand } from './cache-commands.js';
import {
	scaffoldAgentVmProject,
	type GatewayType,
	type ScaffoldAgentVmProjectResult,
} from './init-command.js';

export interface CliDependencies {
	readonly buildControllerStatus: typeof buildControllerStatus;
	readonly createAgeBackupEncryption: typeof createAgeBackupEncryption;
	readonly createControllerClient: typeof createControllerClient;
	readonly createSecretResolver: typeof createOpCliSecretResolver;
	readonly createZoneBackupManager: typeof createZoneBackupManager;
	readonly getCurrentWorkingDirectory?: () => string;
	readonly loadSystemConfig: typeof loadSystemConfig;
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
	readonly runControllerDoctor: typeof runControllerDoctor;
	readonly promptAndStoreServiceAccountToken?: () => Promise<boolean>;
	readonly scaffoldAgentVmProject?: (options: {
		readonly gatewayType: GatewayType;
		readonly targetDir: string;
		readonly zoneId: string;
	}) => Promise<ScaffoldAgentVmProjectResult>;
	readonly startControllerRuntime: (
		options: {
			readonly systemConfig: SystemConfig;
			readonly zoneId: string;
		},
		runtimeDependencies?: ControllerRuntimeDependencies,
	) => Promise<{
		readonly controllerPort: number;
		readonly gateway?: {
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

export interface CliIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

export const defaultCliDependencies: CliDependencies = {
	buildControllerStatus,
	createAgeBackupEncryption,
	createControllerClient,
	createSecretResolver: createOpCliSecretResolver,
	createZoneBackupManager,
	getCurrentWorkingDirectory: () => process.cwd(),
	loadSystemConfig,
	runBuildCommand,
	runCacheCommand,
	resolveServiceAccountToken,
	runControllerDoctor,
	scaffoldAgentVmProject,
	startControllerRuntime: async (runtimeOptions, runtimeDependencies) =>
		await startControllerRuntime(runtimeOptions, runtimeDependencies ?? {}),
	startGatewayZone,
};

export function writeJson(io: CliIo, value: unknown): void {
	io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function resolveConfigPath(argv: readonly string[]): string {
	const configFlagIndex = argv.indexOf('--config');
	if (configFlagIndex >= 0) {
		return argv[configFlagIndex + 1] ?? 'system.json';
	}
	return 'system.json';
}

export function readZoneFlag(argv: readonly string[]): string | undefined {
	const zoneFlagIndex = argv.indexOf('--zone');
	if (zoneFlagIndex >= 0) {
		return argv[zoneFlagIndex + 1];
	}
	return undefined;
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
