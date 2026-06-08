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
	return {
		...options.systemConfig,
		cacheDir: resolveLiveRoundtripCacheDir(),
		runtimeDir: path.join(options.deploymentRoot, 'runtime'),
		systemConfigPath: path.join(options.deploymentRoot, 'config', 'system.json'),
		host: {
			...options.systemConfig.host,
			controllerPort: options.controllerPort,
		},
		tcpPool: {
			basePort: options.toolSshPort,
			size: 1,
		},
		zones: options.systemConfig.zones.map((configuredZone) => {
			const gatewayStateDir = path.join(options.deploymentRoot, 'state', configuredZone.id);
			if (configuredZone.gateway.type === 'openclaw') {
				return {
					...configuredZone,
					gateway: {
						...configuredZone.gateway,
						port: options.gatewayPort,
						stateDir: gatewayStateDir,
						zoneFilesDir: path.join(options.deploymentRoot, 'zone-files', configuredZone.id),
					},
				};
			}
			return {
				...configuredZone,
				gateway: {
					...configuredZone.gateway,
					port: options.gatewayPort,
					stateDir: gatewayStateDir,
				},
			};
		}),
	};
}
