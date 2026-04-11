import type { SystemConfig } from '../controller/system-config.js';

export type GatewayZone = SystemConfig['zones'][number];

export interface StartGatewayZoneOptions {
	readonly pluginSourceDir?: string;
	readonly secretResolver: import('gondolin-core').SecretResolver;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}

export interface GatewayZoneStartResult {
	readonly image: import('gondolin-core').BuildImageResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly vm: import('gondolin-core').ManagedVm;
	readonly zone: GatewayZone;
}

export interface GatewayBuildImageOptions {
	readonly buildConfig: unknown;
	readonly cacheDir: string;
	readonly fullReset?: boolean;
}

export interface GatewayManagedVmFactoryOptions {
	readonly allowedHosts: readonly string[];
	readonly cpus: number;
	readonly env?: Record<string, string>;
	readonly imagePath: string;
	readonly memory: string;
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly secrets: Record<
		string,
		{
			readonly hosts: readonly string[];
			readonly value: string;
		}
	>;
	readonly sessionLabel?: string;
	readonly tcpHosts?: Record<string, string>;
	readonly vfsMounts: Record<
		string,
		{
			readonly kind: 'realfs' | 'realfs-readonly' | 'memory' | 'shadow';
			readonly hostPath?: string;
			readonly shadowConfig?: {
				readonly deny: readonly string[];
				readonly tmpfs: readonly string[];
			};
		}
	>;
}

export function findGatewayZone(systemConfig: SystemConfig, zoneId: string): GatewayZone {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}

	return zone;
}
