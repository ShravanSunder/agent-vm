import type { SecretResolver } from 'gondolin-core';
import { createOpCliSecretResolver, resolveServiceAccountToken } from 'gondolin-core';

import { createAgeBackupEncryption } from '../backup/backup-encryption.js';
import { createZoneBackupManager } from '../backup/backup-manager.js';
import { createControllerClient } from '../controller/controller-client.js';
import type { ControllerRuntimeDependencies } from '../controller/controller-runtime-types.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { loadSystemConfig, type SystemConfig } from '../controller/system-config.js';
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
	readonly runInteractiveProcess?: (
		command: string,
		arguments_: readonly string[],
	) => Promise<void>;
	readonly resolveServiceAccountToken: typeof resolveServiceAccountToken;
	readonly runControllerDoctor: typeof runControllerDoctor;
	readonly promptAndStoreServiceAccountToken?: () => Promise<boolean>;
	readonly scaffoldAgentVmProject?: (options: {
		readonly gatewayType?: GatewayType;
		readonly targetDir: string;
		readonly zoneId: string;
	}) => ScaffoldAgentVmProjectResult;
	readonly startControllerRuntime: (
		options: {
			readonly systemConfig: SystemConfig;
			readonly zoneId: string;
		},
		runtimeDependencies?: ControllerRuntimeDependencies,
	) => Promise<{
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

export function resolveZoneId(systemConfig: SystemConfig, argv: readonly string[]): string {
	const zoneFlagIndex = argv.indexOf('--zone');
	if (zoneFlagIndex >= 0) {
		return argv[zoneFlagIndex + 1] ?? '';
	}
	return systemConfig.zones[0]?.id ?? '';
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

export async function createResolverFromSystemConfig(
	systemConfig: SystemConfig,
	dependencies: Pick<CliDependencies, 'createSecretResolver' | 'resolveServiceAccountToken'>,
): Promise<SecretResolver> {
	const tokenSource = systemConfig.host.secretsProvider.tokenSource;
	const serviceAccountToken = await dependencies.resolveServiceAccountToken(tokenSource);

	return await dependencies.createSecretResolver({
		serviceAccountToken,
	});
}
