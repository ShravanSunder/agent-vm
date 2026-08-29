import os from 'node:os';
import path from 'node:path';

import type { LoadedSystemConfig } from '../config/system-config.js';

export interface CreateLiveRoundtripDeploymentConfigOptions {
	readonly controllerPort: number;
	readonly deploymentRoot: string;
	readonly gatewayPort: number;
	readonly systemConfig: LoadedSystemConfig;
	readonly toolSshPort: number;
}

export function resolveLiveRoundtripCacheDir(
	env: Partial<Record<'AGENT_VM_E2E_CACHE_DIR', string>> = process.env,
): string {
	const configuredCacheRoot = env.AGENT_VM_E2E_CACHE_DIR;
	const cacheRoot =
		configuredCacheRoot !== undefined && configuredCacheRoot.length > 0
			? path.resolve(configuredCacheRoot)
			: path.join(os.tmpdir(), 'agent-vm-e2e-cache');
	return path.join(cacheRoot, 'live-roundtrip');
}

export function createLiveRoundtripDeploymentConfig(
	options: CreateLiveRoundtripDeploymentConfigOptions,
): LoadedSystemConfig {
	const {
		githubToken: _unusedGithubToken,
		secretsProvider: _unusedSecretsProvider,
		...modelRoundtripHost
	} = options.systemConfig.host;
	return {
		...options.systemConfig,
		cacheDir: resolveLiveRoundtripCacheDir(),
		controllerRuntimeDir: path.join(options.deploymentRoot, 'controller-runtime'),
		controllerStateDir: path.join(options.deploymentRoot, 'controller-state'),
		storageRootDir: options.deploymentRoot,
		systemConfigPath: path.join(options.deploymentRoot, 'config', 'system.json'),
		host: {
			...modelRoundtripHost,
			controllerPort: options.controllerPort,
		},
		tcpPool: {
			basePort: options.toolSshPort,
			size: 1,
		},
		zones: options.systemConfig.zones.map((configuredZone) => {
			const zoneRootDir = path.join(options.deploymentRoot, configuredZone.id);
			const gatewayStateDir = path.join(zoneRootDir, 'state');
			const zoneRuntimeDir = path.join(zoneRootDir, 'runtime');
			if (configuredZone.gateway.type === 'hermes') {
				return {
					...configuredZone,
					gateway: {
						...configuredZone.gateway,
						port: options.gatewayPort,
						stateDir: gatewayStateDir,
						zoneFilesDir: path.join(zoneRootDir, 'zone-files'),
						zoneRuntimeDir,
					},
				};
			}
			return {
				...configuredZone,
				gateway: {
					...configuredZone.gateway,
					port: options.gatewayPort,
					stateDir: gatewayStateDir,
					zoneRuntimeDir,
				},
			};
		}),
	};
}
