import type {
	GatewayIngressConfig,
	GatewayProcessSpec,
	GatewayZoneConfig,
} from '@agent-vm/gateway-interface';

import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import type { RunTaskFn } from '../shared/run-task.js';

export type GatewayZone = SystemConfig['zones'][number];

export interface StartGatewayZoneOptions {
	readonly environmentOverride?: Record<string, string>;
	readonly prebuiltImage?: import('@agent-vm/gondolin-adapter').BuildImageResult | undefined;
	readonly runTask?: RunTaskFn;
	readonly runtimeEnvironment?: Readonly<Record<string, string>>;
	readonly runtimePluginConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly secretResolver: import('@agent-vm/secret-management').SecretResolver;
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
	readonly fullReset?: boolean;
}

export interface GatewayManagedVmFactoryOptions {
	readonly allowedHosts: readonly string[];
	readonly cpus: number;
	readonly env?: Record<string, string>;
	readonly imagePath: string;
	readonly memory: string;
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly runtimeRootfsSize?: string;
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

function resolveGatewayIngressConfig(
	ingress: GatewayZone['gateway']['ingress'],
): GatewayIngressConfig | undefined {
	if (!ingress) {
		return undefined;
	}

	const resolvedIngress = {
		...(ingress.upstreamHeaderTimeoutMs === undefined
			? {}
			: { upstreamHeaderTimeoutMs: ingress.upstreamHeaderTimeoutMs }),
		...(ingress.upstreamResponseTimeoutMs === undefined
			? {}
			: { upstreamResponseTimeoutMs: ingress.upstreamResponseTimeoutMs }),
	};

	return Object.keys(resolvedIngress).length > 0 ? resolvedIngress : undefined;
}

export function mapSystemGatewayZoneToLifecycleZone(zone: GatewayZone): GatewayZoneConfig {
	const ingress = resolveGatewayIngressConfig(zone.gateway.ingress);
	const baseGateway = {
		cpus: zone.gateway.cpus,
		config: zone.gateway.config,
		...(ingress ? { ingress } : {}),
		memory: zone.gateway.memory,
		port: zone.gateway.port,
		...(zone.gateway.runtimeRootfsSize
			? { runtimeRootfsSize: zone.gateway.runtimeRootfsSize }
			: {}),
		ssh: zone.gateway.ssh ?? { secretEnv: 'explicit' },
		stateDir: zone.gateway.stateDir,
		...(zone.gateway.authProfilesRef ? { authProfilesRef: zone.gateway.authProfilesRef } : {}),
	};

	return {
		id: zone.id,
		...(zone.agents === undefined ? {} : { agents: zone.agents }),
		gateway:
			zone.gateway.type === 'openclaw'
				? {
						...baseGateway,
						type: 'openclaw',
						controlAuth: zone.gateway.controlAuth,
						zoneFilesDir: zone.gateway.zoneFilesDir,
						...(zone.gateway.authProfilesByAgent
							? { authProfilesByAgent: zone.gateway.authProfilesByAgent }
							: {}),
						...(zone.gateway.rawEnvSecrets ? { rawEnvSecrets: zone.gateway.rawEnvSecrets } : {}),
					}
				: {
						...baseGateway,
						type: 'worker',
					},
		secrets: zone.secrets,
		egressHosts: zone.egressHosts,
		...(zone.defaultToolVmProfile ? { defaultToolVmProfile: zone.defaultToolVmProfile } : {}),
		...(zone.mcpPortal === undefined ? {} : { mcpPortal: zone.mcpPortal }),
		websocketBypass: zone.websocketBypass,
	};
}
