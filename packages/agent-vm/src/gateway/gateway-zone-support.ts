import type {
	GatewayIngressConfig,
	ManagedGatewayBootContract,
	GatewayProcessSpec,
	GatewayZoneConfig,
	GatewayZoneObservabilityConfig,
} from '@agent-vm/gateway-lifecycle';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import {
	createGatewayTelemetryProducerSafetyContract,
	gatewayFrameworkTelemetryServiceNames,
	gatewayToolPortalTelemetryServiceName,
} from '@agent-vm/gateway-lifecycle';
import type {
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmEnableSshOptions,
	ManagedVmExecCommand,
	ManagedVmExecOptions,
	ManagedVmExecProcess,
	ManagedVmImageBuildResult,
	ManagedVmSshAccess,
} from '@agent-vm/managed-vm';

import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import type { ControllerApprovalLedger } from '../controller/approval/controller-approval-ledger.js';
import type {
	ControlSessionDispatcher,
	ControlSessionFenceRegistry,
	ConnectGatewayControlSessionOptions,
	GatewayControlControllerExecutionOperations,
	GatewayControlAttemptOutcome,
	GatewayControlAttachmentGapTransition,
	GatewayControlBindingPublicationSource,
	GatewayControlLeaseRpcOperations,
	GatewayControlProcessAdmissionCoordinator,
	GatewayControlReconnectExhaustedTransition,
	GatewayDisposableControlSessionClient,
	GatewayControlSessionMaterial,
} from '../controller/control-session/index.js';
import type {
	ControllerDiagnosticLevel,
	ControllerDiagnosticTelemetry,
} from '../controller/controller-diagnostic-logging.js';
import type { HealthEventStore } from '../controller/health/health-event-store.js';
import type { OpenClawRuntimeStatusStore } from '../controller/openclaw-runtime-status.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import type { ManagedVmProcessTarget } from '../shared/controller-managed-vm-termination.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';

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

export interface GatewayRuntimeAttachmentLost {
	readonly connectionId: string;
	readonly gateway: GatewayEpochIdentity;
	readonly observationSequence: number;
}

export type GatewayControlSessionAttemptOutcome = GatewayControlAttemptOutcome & {
	readonly gateway: GatewayEpochIdentity;
	readonly processEpoch: string;
};

export interface GatewayControlSessionHealthEvidence {
	readonly event: Extract<AgentVmHealthEvent, { readonly kind: 'gateway-control-session' }>;
	readonly gateway: GatewayEpochIdentity;
	readonly recordKind: 'durable-and-live' | 'live-only';
}

export interface StartGatewayZoneOptions {
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
	readonly credentialedRuntimeRegistryPublisher?: import('../controller/credentialed-runtime/credentialed-runtime-registry.js').ControllerCredentialedRuntimeRegistryPublisher;
	readonly environmentOverride?: Record<string, string>;
	readonly gatewayControlControllerExecutions?: GatewayControlControllerExecutionOperations;
	readonly gatewayControlApprovalLedger?: ControllerApprovalLedger;
	readonly gatewayControlBindingPublicationSource?: GatewayControlBindingPublicationSource;
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
	readonly onControlSessionHealthEvidence?: (evidence: GatewayControlSessionHealthEvidence) => void;
	readonly onControlSessionReconnectExhausted?: (
		transition: GatewayControlSessionReconnectExhausted,
	) => void;
	readonly onGatewayRuntimeAttachmentLost?: (transition: GatewayRuntimeAttachmentLost) => void;
	readonly onCredentialedRuntimeZoneStopping?: () => Promise<void>;
	readonly prebuiltImage?: ManagedVmImageBuildResult | undefined;
	readonly runTask?: RunTaskFn;
	readonly runtimeEnvironment?: Readonly<Record<string, string>>;
	readonly runtimeRecordTarget:
		| import('../controller/durable-state/controller-state-record-paths.js').ControllerManagedGatewayRuntimeRecordTarget
		| import('../controller/durable-state/controller-state-record-paths.js').ControllerWorkerTaskRuntimeRecordTarget;
	readonly runtimePluginConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly secretResolver: import('@agent-vm/secret-management').SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly tcpHostsOverride?: Record<string, string>;
	readonly vfsMountsOverride?: ManagedVmCreateRequest['mounts'];
	readonly writeLog?: (
		level: ControllerDiagnosticLevel,
		telemetry?: ControllerDiagnosticTelemetry,
	) => void;
	readonly zoneId: string;
	readonly zoneOverride?: GatewayZone;
}

export type GatewayZonePreflightOptions = Omit<
	StartGatewayZoneOptions,
	'createVmOwnership' | 'runtimeRecordTarget'
>;

export type GatewayZoneCleanupFailureStage =
	| 'control-session-disposal'
	| 'control-session-material-deletion'
	| 'ingress-withdrawal'
	| 'managed-boot-input-release'
	| 'runtime-record-deletion';

export interface GatewayZoneCleanupFailure {
	readonly error: unknown;
	readonly stage: GatewayZoneCleanupFailureStage;
}

export type GatewayZoneDestroyResult =
	| { readonly kind: 'destroyed-clean' }
	| {
			readonly cleanupFailures: readonly [
				GatewayZoneCleanupFailure,
				...GatewayZoneCleanupFailure[],
			];
			readonly kind: 'destroyed-cleanup-incomplete';
	  };

export interface GatewayZoneVmOperations extends Pick<
	ManagedVm,
	'enableSsh' | 'exec' | 'getHostProcessId' | 'id'
> {}

export function createGatewayZoneVmOperations(managedVm: ManagedVm): GatewayZoneVmOperations {
	return {
		enableSsh(options?: ManagedVmEnableSshOptions): Promise<ManagedVmSshAccess> {
			return managedVm.enableSsh(options);
		},
		exec(command: ManagedVmExecCommand, options?: ManagedVmExecOptions): ManagedVmExecProcess {
			return managedVm.exec(command, options);
		},
		getHostProcessId(): number | null {
			return managedVm.getHostProcessId();
		},
		id: managedVm.id,
	};
}

interface GatewayZoneStartResultBase {
	destroyGateway(): Promise<GatewayZoneDestroyResult>;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly image: ManagedVmImageBuildResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly vm: GatewayZoneVmOperations;
	readonly zone: GatewayZone;
}

export interface ManagedGatewayZoneStartResult extends GatewayZoneStartResultBase {
	readonly bootContract: ManagedGatewayBootContract;
	readonly controlSession?: GatewayDisposableControlSessionClient | undefined;
	readonly executionModel: 'managed-gateway';
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
}

export interface DirectProcessGatewayZoneStartResult extends GatewayZoneStartResultBase {
	readonly executionModel: 'direct-process';
	readonly processSpec: GatewayProcessSpec;
	readonly processTarget: ManagedVmProcessTarget;
}

export type GatewayZoneStartResult =
	| DirectProcessGatewayZoneStartResult
	| ManagedGatewayZoneStartResult;

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
	readonly onHelloResponse?: ConnectGatewayControlSessionOptions['onHelloResponse'];
	readonly onReconnectExhausted?: (transition: GatewayControlReconnectExhaustedTransition) => void;
	readonly processAdmissionCoordinator?: GatewayControlProcessAdmissionCoordinator;
	readonly recordHealthEvent?: ConnectGatewayControlSessionOptions['recordHealthEvent'];
	readonly recordLiveHealthEvent?: ConnectGatewayControlSessionOptions['recordLiveHealthEvent'];
	readonly resolveInboundStablePrincipal?: ConnectGatewayControlSessionOptions['resolveInboundStablePrincipal'];
	readonly sessionFenceRegistry?: ControlSessionFenceRegistry;
	readonly signal?: AbortSignal;
}) => Promise<GatewayDisposableControlSessionClient>;

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

	const frameworkServiceName =
		zone.gateway.type === 'openclaw'
			? gatewayFrameworkTelemetryServiceNames.openclaw
			: gatewayFrameworkTelemetryServiceNames.hermes;
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
		framework: {
			...zone.observability.services.framework,
			...createGatewayTelemetryProducerSafetyContract(),
			serviceName: frameworkServiceName,
		},
		...(zone.observability.openclaw === undefined
			? {}
			: { openclaw: { diagnosticsFlags: zone.observability.openclaw.diagnosticsFlags } }),
		toolPortal: {
			...zone.observability.services.toolPortal,
			...createGatewayTelemetryProducerSafetyContract(),
			serviceName: gatewayToolPortalTelemetryServiceName,
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
	};

	return {
		id: zone.id,
		...(zone.agents === undefined ? {} : { agents: zone.agents }),
		gateway: (() => {
			switch (zone.gateway.type) {
				case 'openclaw':
					return {
						...baseGateway,
						type: 'openclaw',
						controlAuth: zone.gateway.controlAuth,
						zoneFilesDir: zone.gateway.zoneFilesDir,
						...(zone.gateway.authProfilesRef
							? { authProfilesRef: zone.gateway.authProfilesRef }
							: {}),
						...(zone.gateway.authProfilesByAgent
							? { authProfilesByAgent: zone.gateway.authProfilesByAgent }
							: {}),
						...(zone.gateway.rawEnvSecrets ? { rawEnvSecrets: zone.gateway.rawEnvSecrets } : {}),
					};
				case 'hermes':
					return {
						...baseGateway,
						type: 'hermes',
						profileSecretProjectionsByAgent: zone.gateway.profileSecretProjectionsByAgent,
						profilesByAgent: zone.gateway.profilesByAgent,
						zoneFilesDir: zone.gateway.zoneFilesDir,
					};
				case 'worker':
					return {
						...baseGateway,
						type: 'worker',
					};
				default: {
					const exhaustiveGateway: never = zone.gateway;
					throw new Error(`Unhandled gateway type: ${String(exhaustiveGateway)}`);
				}
			}
		})(),
		secrets: zone.secrets,
		egressHosts: zone.egressHosts,
		...(zone.defaultToolVmProfile ? { defaultToolVmProfile: zone.defaultToolVmProfile } : {}),
		...(zone.toolPortal === undefined ? {} : { toolPortal: zone.toolPortal }),
		...(observability === undefined ? {} : { observability }),
		...(zone.websocketUpgrades === undefined ? {} : { websocketUpgrades: zone.websocketUpgrades }),
	};
}
