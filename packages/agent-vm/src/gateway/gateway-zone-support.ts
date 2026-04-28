import type { GatewayProcessSpec, GatewayZoneConfig } from '@agent-vm/gateway-interface';

import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import type { RunTaskFn } from '../shared/run-task.js';

export type GatewayZone = SystemConfig['zones'][number];

export interface StartGatewayZoneOptions {
	readonly environmentOverride?: Record<string, string>;
	readonly runTask?: RunTaskFn;
	readonly secretResolver: import('@agent-vm/gondolin-adapter').SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly tcpHostsOverride?: Record<string, string>;
	readonly vfsMountsOverride?: GatewayManagedVmFactoryOptions['vfsMounts'];
	readonly zoneId: string;
	readonly zoneOverride?: GatewayZone;
}

export interface GatewayZoneStartResult {
	readonly image: import('@agent-vm/gondolin-adapter').BuildImageResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly processSpec: GatewayProcessSpec;
	readonly vm: import('@agent-vm/gondolin-adapter').ManagedVm;
	readonly zone: GatewayZone;
}

export interface GatewayBuildImageOptions {
	readonly buildConfig: unknown;
	readonly cacheDir: string;
	readonly fingerprintInput: unknown;
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

export function mapSystemGatewayZoneToLifecycleZone(zone: GatewayZone): GatewayZoneConfig {
	const baseGateway = {
		cpus: zone.gateway.cpus,
		config: zone.gateway.config,
		memory: zone.gateway.memory,
		port: zone.gateway.port,
		stateDir: zone.gateway.stateDir,
		authProfilesRef: zone.gateway.authProfilesRef,
	};

	return {
		id: zone.id,
		gateway:
			zone.gateway.type === 'openclaw'
				? {
						...baseGateway,
						type: 'openclaw',
						zoneFilesDir: zone.gateway.zoneFilesDir,
					}
				: {
						...baseGateway,
						type: 'worker',
					},
		secrets: Object.fromEntries(
			Object.entries(zone.secrets).map(([secretName, secretConfig]) => [
				secretName,
				secretConfig.source === 'environment'
					? {
							source: 'environment' as const,
							...(secretConfig.hosts ? { hosts: secretConfig.hosts } : {}),
							injection: secretConfig.injection,
							envVar: secretConfig.envVar,
						}
					: {
							source: '1password' as const,
							...(secretConfig.hosts ? { hosts: secretConfig.hosts } : {}),
							injection: secretConfig.injection,
							ref: secretConfig.ref,
						},
			]),
		),
		allowedHosts: zone.allowedHosts,
		...(zone.toolProfile ? { toolProfile: zone.toolProfile } : {}),
		websocketBypass: zone.websocketBypass,
	};
}
