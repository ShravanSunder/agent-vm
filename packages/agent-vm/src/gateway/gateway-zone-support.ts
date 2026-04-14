import type { GatewayProcessSpec, GatewayZoneConfig } from '@shravansunder/gateway-interface';

import type { SystemConfig } from '../config/system-config.js';
import type { RunTaskFn } from '../shared/run-task.js';

export type GatewayZone = SystemConfig['zones'][number];

export interface StartGatewayZoneOptions {
	readonly runTask?: RunTaskFn;
	readonly secretResolver: import('@shravansunder/gondolin-core').SecretResolver;
	readonly systemConfig: SystemConfig;
	readonly tcpHostsOverride?: Record<string, string>;
	readonly zoneId: string;
	readonly zoneOverride?: GatewayZone;
}

export interface GatewayZoneStartResult {
	readonly image: import('@shravansunder/gondolin-core').BuildImageResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly processSpec: GatewayProcessSpec;
	readonly vm: import('@shravansunder/gondolin-core').ManagedVm;
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

export function mapSystemGatewayZoneToLifecycleZone(zone: GatewayZone): GatewayZoneConfig {
	return {
		id: zone.id,
		gateway: {
			cpus: zone.gateway.cpus,
			gatewayConfig: zone.gateway.gatewayConfig,
			memory: zone.gateway.memory,
			port: zone.gateway.port,
			stateDir: zone.gateway.stateDir,
			type: zone.gateway.type,
			workspaceDir: zone.gateway.workspaceDir,
			authProfilesRef: zone.gateway.authProfilesRef,
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
		toolProfile: zone.toolProfile,
		websocketBypass: zone.websocketBypass,
	};
}
