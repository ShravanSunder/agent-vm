import type {
	GatewayIngressConfig,
	GatewayProcessSpec,
	GatewayZoneConfig,
	GatewayZoneObservabilityConfig,
} from '@agent-vm/gateway-interface';

import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import type {
	ControlSessionDispatcher,
	ControlSessionFenceRegistry,
	ConnectGatewayControlSessionOptions,
	GatewayControlControllerHostActionOperations,
	GatewayControlAttemptOutcome,
	GatewayControlAttachmentGapTransition,
	GatewayControlLeaseRpcOperations,
	GatewayControlProcessAdmissionCoordinator,
	GatewayControlReconnectExhaustedTransition,
	GatewayDisposableControlSessionClient,
	GatewayControlSessionMaterial,
} from '../controller/control-session/index.js';
import type { GatewayVmRecoverySourceKey } from '../controller/health/gateway-vm-recovery-policy.js';
import type { HealthEventStore } from '../controller/health/health-event-store.js';
import type { OpenClawRuntimeStatusStore } from '../controller/openclaw-runtime-status.js';
import type { OpenClawProcessSupervisor } from '../controller/process-supervisor/openclaw-process-supervisor.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type {
	OpenClawGatewayProcessEpochOwner,
	OpenClawProcessEpochLossBarrier,
} from './openclaw-gateway-process-epoch-owner.js';

export type GatewayZone = SystemConfig['zones'][number];

export interface PendingGatewayVmCreationContainment {
	contain(): Promise<void>;
}

export type GatewayControlSessionAttachmentGap = GatewayControlAttachmentGapTransition & {
	readonly gateway: GatewayEpochIdentity;
};

export type GatewayControlSessionReconnectExhausted = GatewayControlReconnectExhaustedTransition & {
	readonly gateway: GatewayEpochIdentity;
};

export interface GatewayControlSessionHeartbeat {
	readonly gateway: GatewayEpochIdentity;
	readonly observedAtMs: number;
	readonly processEpoch: string;
}

export type GatewayControlSessionAttemptOutcome = GatewayControlAttemptOutcome & {
	readonly gateway: GatewayEpochIdentity;
	readonly processEpoch: string;
};

export interface StartGatewayZoneOptions {
	readonly beginProcessEpochLoss?: (loss: {
		readonly ambiguousAtMs: number;
		readonly gateway: GatewayEpochIdentity;
		readonly processEpoch: string;
	}) => OpenClawProcessEpochLossBarrier;
	readonly controlSession?: {
		readonly controllerEpoch: string;
	};
	readonly createVmOwnership: (options: {
		readonly controlIdentity?: {
			readonly bootId: string;
			readonly generationId: string;
		};
		readonly kind: 'gateway-epoch' | 'standalone';
		readonly sessionLabel: string;
		readonly zoneId: string;
	}) => Promise<GatewayVmLifecycleAuthority>;
	readonly environmentOverride?: Record<string, string>;
	readonly gatewayControlControllerHostActions?: GatewayControlControllerHostActionOperations;
	readonly gatewayControlLeaseRpc?: GatewayControlLeaseRpcOperations;
	readonly gatewayControlProcessAdmissionCoordinator?: GatewayControlProcessAdmissionCoordinator;
	readonly gitReadAllowlistRepos?: readonly string[];
	readonly healthEventStore?: HealthEventStore;
	readonly openClawRuntimeStatusStore?: OpenClawRuntimeStatusStore;
	readonly observabilityStartupCheck?: 'default' | 'skip';
	readonly onPendingVmCreation?: (containment: PendingGatewayVmCreationContainment) => void;
	readonly onControlSessionAttemptOutcome?: (outcome: GatewayControlSessionAttemptOutcome) => void;
	readonly onControlSessionAttachmentGap?: (transition: GatewayControlSessionAttachmentGap) => void;
	readonly onControlSessionHeartbeat?: (transition: GatewayControlSessionHeartbeat) => void;
	readonly onControlSessionReconnectExhausted?: (
		transition: GatewayControlSessionReconnectExhausted,
	) => void;
	readonly prebuiltImage?: import('@agent-vm/gondolin-adapter').BuildImageResult | undefined;
	readonly runTask?: RunTaskFn;
	readonly runtimeEnvironment?: Readonly<Record<string, string>>;
	readonly runtimePluginConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly secretResolver: import('@agent-vm/secret-management').SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly tcpHostsOverride?: Record<string, string>;
	readonly vfsMountsOverride?: GatewayManagedVmFactoryOptions['vfsMounts'];
	readonly writeLog?: (message: string) => void;
	readonly zoneId: string;
	readonly zoneOverride?: GatewayZone;
}

export type GatewayZonePreflightOptions = Omit<StartGatewayZoneOptions, 'createVmOwnership'>;

export interface GatewayZoneStartResult {
	readonly controlSession?: GatewayDisposableControlSessionClient | undefined;
	readonly controlSessionRecoverySourceKey?: GatewayVmRecoverySourceKey | undefined;
	readonly image: import('@agent-vm/gondolin-adapter').BuildImageResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly openClawProcessSupervisor?: OpenClawProcessSupervisor | undefined;
	readonly openClawProcessEpochOwner?: OpenClawGatewayProcessEpochOwner | undefined;
	readonly processEpoch?: string | undefined;
	readonly processSpec: GatewayProcessSpec;
	readonly terminateVm: () => Promise<void>;
	readonly vm: import('@agent-vm/gondolin-adapter').ManagedVm;
	readonly vmOwnership: GatewayVmLifecycleAuthority;
	readonly zone: GatewayZone;
}

export type GatewayControlSessionMaterialFactory = (options: {
	readonly controllerEpoch: string;
	readonly zoneId: string;
}) => GatewayControlSessionMaterial;

export type GatewayControlSessionConnector = (options: {
	readonly dispatcher?: ControlSessionDispatcher;
	readonly endpoint: {
		readonly host: string;
		readonly path: string;
		readonly port: number;
	};
	readonly material: GatewayControlSessionMaterial;
	readonly onAttemptOutcome?: ConnectGatewayControlSessionOptions['onAttemptOutcome'];
	readonly onAttachmentGap?: (transition: GatewayControlAttachmentGapTransition) => void;
	readonly onReconnectExhausted?: (transition: GatewayControlReconnectExhaustedTransition) => void;
	readonly processAdmissionCoordinator?: GatewayControlProcessAdmissionCoordinator;
	readonly recordHealthEvent?: ConnectGatewayControlSessionOptions['recordHealthEvent'];
	readonly resolveInboundStablePrincipal?: ConnectGatewayControlSessionOptions['resolveInboundStablePrincipal'];
	readonly sessionFenceRegistry?: ControlSessionFenceRegistry;
	readonly signal?: AbortSignal;
}) => Promise<GatewayDisposableControlSessionClient>;

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
	readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
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

export const observabilityCollectorHost = 'otel-collector.observability.vm.host';
const otlpGrpcPort = 4317;
const otlpHttpPort = 4318;

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

function resolveObservabilityTargetHost(bindAddress: '127.0.0.1' | '::1'): string {
	return bindAddress === '::1' ? '[::1]' : bindAddress;
}

function mapSystemZoneObservabilityToLifecycleObservability(
	zone: GatewayZone,
	hostObservability: LoadedSystemConfig['host']['observability'] | undefined,
): GatewayZoneObservabilityConfig | undefined {
	if (hostObservability?.enabled !== true || zone.observability?.enabled !== true) {
		return undefined;
	}

	const { openclaw } = zone.observability;
	return {
		mode: 'collector',
		collector: {
			host: observabilityCollectorHost,
			grpcPort: otlpGrpcPort,
			httpPort: otlpHttpPort,
			targetHost: resolveObservabilityTargetHost(hostObservability.bindAddress),
			targetGrpcPort: hostObservability.ports.collectorGrpc,
			targetHttpPort: hostObservability.ports.collectorHttp,
		},
		openclaw: {
			serviceName: openclaw.serviceName,
			traces: openclaw.traces,
			metrics: openclaw.metrics,
			logs: openclaw.logs,
			sampleRate: openclaw.sampleRate,
			flushIntervalMs: openclaw.flushIntervalMs,
			diagnosticsFlags: openclaw.diagnosticsFlags,
		},
	};
}

export function mapSystemGatewayZoneToLifecycleZone(
	zone: GatewayZone,
	options: {
		readonly hostObservability?: LoadedSystemConfig['host']['observability'];
	} = {},
): GatewayZoneConfig {
	const ingress = resolveGatewayIngressConfig(zone.gateway.ingress);
	const observability = mapSystemZoneObservabilityToLifecycleObservability(
		zone,
		options.hostObservability,
	);
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
		...(zone.gateway.type === 'openclaw' && zone.gateway.zoneGit !== undefined
			? { gitReadAllowlistRepos: [zone.gateway.zoneGit.remote.repoUrl] }
			: {}),
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
		...(zone.toolPortal === undefined ? {} : { toolPortal: zone.toolPortal }),
		...(observability === undefined ? {} : { observability }),
		...(zone.websocketUpgrades === undefined ? {} : { websocketUpgrades: zone.websocketUpgrades }),
	};
}
