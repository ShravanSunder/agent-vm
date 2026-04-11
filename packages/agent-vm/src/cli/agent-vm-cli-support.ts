import type { SecretResolver } from 'gondolin-core';
import { createSecretResolver, resolveServiceAccountToken } from 'gondolin-core';

import { createControllerClient } from '../controller/controller-client.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { loadSystemConfig, type SystemConfig } from '../controller/system-config.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { buildControllerStatus } from '../operations/controller-status.js';
import { runControllerDoctor } from '../operations/doctor.js';
import { createAgeEncryption } from '../snapshots/snapshot-encryption.js';
import { createSnapshotManager } from '../snapshots/snapshot-manager.js';
import { runBuildCommand } from './build-command.js';
import { scaffoldAgentVmProject, type ScaffoldAgentVmProjectResult } from './init-command.js';

export interface CliDependencies {
	readonly buildControllerStatus: typeof buildControllerStatus;
	readonly createAgeEncryption: typeof createAgeEncryption;
	readonly createControllerClient: typeof createControllerClient;
	readonly createSecretResolver: typeof createSecretResolver;
	readonly createSnapshotManager: typeof createSnapshotManager;
	readonly getCurrentWorkingDirectory?: () => string;
	readonly loadSystemConfig: typeof loadSystemConfig;
	readonly runBuildCommand?: typeof runBuildCommand;
	readonly runInteractiveProcess?: (
		command: string,
		arguments_: readonly string[],
	) => Promise<void>;
	readonly resolveServiceAccountToken: typeof resolveServiceAccountToken;
	readonly runControllerDoctor: typeof runControllerDoctor;
	readonly scaffoldAgentVmProject?: (options: {
		readonly targetDir: string;
		readonly zoneId: string;
	}) => ScaffoldAgentVmProjectResult;
	readonly startControllerRuntime: (options: {
		readonly systemConfig: SystemConfig;
		readonly zoneId: string;
	}) => Promise<{
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
	createAgeEncryption,
	createControllerClient,
	createSecretResolver,
	createSnapshotManager,
	getCurrentWorkingDirectory: () => process.cwd(),
	loadSystemConfig,
	runBuildCommand,
	resolveServiceAccountToken,
	runControllerDoctor,
	scaffoldAgentVmProject,
	startControllerRuntime: async (runtimeOptions) =>
		await startControllerRuntime(runtimeOptions, {}),
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
