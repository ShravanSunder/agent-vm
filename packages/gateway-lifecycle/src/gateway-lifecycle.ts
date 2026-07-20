import type { MediatedSecretSpec, SecretResolver } from '@agent-vm/secret-management';

import type { EgressHostConfig, VmAudience } from './audience.js';
import type { GatewayControlPrivateEnvironmentName } from './gateway-control-private-environment.js';
import type { GatewayProcessSpec } from './gateway-process-spec.js';
import type { GatewayType } from './gateway-runtime-contract.js';
import type { GatewayVmRequirements } from './gateway-vm-spec.js';
import type { ManagedFrameworkServiceBootMetadata } from './managed-gateway-boot-contract.js';
import type { WebSocketUpgradeConfig } from './websocket-upgrade-policy.js';

/**
 * Describes how to run interactive auth for a gateway type.
 * Static property — available without a running VM.
 */
export interface GatewayAuthConfig {
	/**
	 * Shell command to list available auth providers inside the VM.
	 * Should output one provider name per line to stdout.
	 */
	readonly listProvidersCommand: string;

	/**
	 * Build the shell command for interactive auth login.
	 * The CLI passes this as the SSH remote command with -t (TTY).
	 */
	readonly buildLoginCommand: (
		provider: string,
		options?: {
			readonly deviceCode?: boolean;
			readonly agentId?: string;
			readonly profileId?: string;
		},
	) => string;

	/**
	 * Build the shell command for listing provider auth profiles for one agent.
	 * The CLI uses this after login to verify requested profile IDs exist.
	 */
	readonly buildProfileListCommand: (
		provider: string,
		options: {
			readonly agentId: string;
		},
	) => string;
}

interface GatewayAuthProfilesRef {
	readonly source: '1password' | 'config' | 'environment';
}

interface OnePasswordGatewayAuthProfilesRef extends GatewayAuthProfilesRef {
	readonly source: '1password';
	readonly ref: string;
}

interface EnvironmentGatewayAuthProfilesRef extends GatewayAuthProfilesRef {
	readonly source: 'environment';
	readonly envVar: string;
}

interface ConfigGatewayAuthProfilesRef extends GatewayAuthProfilesRef {
	readonly source: 'config';
	readonly value: string;
}

export type GatewaySshSecretEnvMode = 'always' | 'explicit' | 'never';

export interface GatewaySshConfig {
	readonly secretEnv: GatewaySshSecretEnvMode;
}

export interface GatewayIngressConfig {
	readonly upstreamHeaderTimeoutMs?: number;
	readonly upstreamResponseTimeoutMs?: number;
}

export interface OpenClawGatewayControlAuthConfig {
	readonly mode: 'token';
	readonly secret: string;
}

interface OpenClawAuthLoginProviderConfig {
	readonly profileIds: readonly string[];
}

interface OpenClawAuthLoginConfig {
	readonly defaultAgent?: string;
	readonly providers: Readonly<Record<string, OpenClawAuthLoginProviderConfig>>;
}

interface GatewayZoneBaseGatewayConfig {
	readonly type: GatewayType;
	readonly memory: string;
	readonly cpus: number;
	readonly port: number;
	readonly ingress?: GatewayIngressConfig;
	readonly config: string;
	readonly stateDir: string;
	readonly runtimeRootfsSize?: string;
	readonly ssh: GatewaySshConfig;
}

interface OpenClawGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'openclaw';
	readonly controlAuth: OpenClawGatewayControlAuthConfig;
	readonly zoneFilesDir: string;
	readonly authProfilesRef?:
		| ConfigGatewayAuthProfilesRef
		| OnePasswordGatewayAuthProfilesRef
		| EnvironmentGatewayAuthProfilesRef
		| undefined;
	readonly authProfilesByAgent?: Readonly<
		Record<
			string,
			| ConfigGatewayAuthProfilesRef
			| OnePasswordGatewayAuthProfilesRef
			| EnvironmentGatewayAuthProfilesRef
		>
	>;
	readonly authLogin?: OpenClawAuthLoginConfig;
	readonly rawEnvSecrets?: readonly string[];
}

interface HermesGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'hermes';
	readonly zoneFilesDir: string;
	readonly profilesByAgent: Readonly<Record<string, string>>;
}

interface WorkerGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'worker';
}

type GatewayZoneGatewayConfig =
	| OpenClawGatewayZoneGatewayConfig
	| HermesGatewayZoneGatewayConfig
	| WorkerGatewayZoneGatewayConfig;

interface OnePasswordSecretSourceConfig {
	readonly source: '1password';
	readonly ref: string;
}

interface EnvironmentSecretSourceConfig {
	readonly source: 'environment';
	readonly envVar: string;
}

interface ConfigSecretSourceConfig {
	readonly source: 'config';
	readonly value: string;
}

type SecretSourceConfig =
	| OnePasswordSecretSourceConfig
	| EnvironmentSecretSourceConfig
	| ConfigSecretSourceConfig;

export type EnvInjectedGatewaySecretConfig = SecretSourceConfig & {
	readonly audience: 'gateway';
	readonly injection: 'env';
};

export type HttpMediatedGatewaySecretConfig = SecretSourceConfig & {
	readonly audience: VmAudience;
	readonly injection: 'http-mediation';
	readonly hosts: readonly string[];
};

export type GatewaySecretConfig = EnvInjectedGatewaySecretConfig | HttpMediatedGatewaySecretConfig;

export const gatewayToolPortalTelemetryServiceName = 'agent-vm-tool-portal' as const;
export const gatewayFrameworkTelemetryServiceNames = Object.freeze({
	hermes: 'agent-vm-hermes',
	openclaw: 'agent-vm-openclaw',
});

export const gatewayTelemetrySourcePolicy = Object.freeze({
	admitBaggage: false,
	captureContent: false,
});

export const gatewayTelemetryAdmissionLimits = Object.freeze({
	maxExportBatchRecords: 64,
	maxQueuedRecordsPerSignal: 256,
	maxRecordBytes: 65_536,
});

export type GatewayTelemetrySourcePolicy = typeof gatewayTelemetrySourcePolicy;
export type GatewayTelemetryAdmissionLimits = typeof gatewayTelemetryAdmissionLimits;

export interface GatewayTelemetrySignalPolicy {
	readonly traces: boolean;
	readonly metrics: boolean;
	readonly logs: boolean;
	readonly sampleRate: number;
	readonly flushIntervalMs: number;
}

export interface GatewayTelemetryProducerSafetyContract {
	readonly admissionLimits: GatewayTelemetryAdmissionLimits;
	readonly sourcePolicy: GatewayTelemetrySourcePolicy;
}

export interface GatewayFrameworkTelemetryProducerConfig
	extends GatewayTelemetrySignalPolicy, GatewayTelemetryProducerSafetyContract {
	readonly serviceName: (typeof gatewayFrameworkTelemetryServiceNames)[keyof typeof gatewayFrameworkTelemetryServiceNames];
}

export interface GatewayToolPortalTelemetryProducerConfig
	extends GatewayTelemetrySignalPolicy, GatewayTelemetryProducerSafetyContract {
	readonly serviceName: typeof gatewayToolPortalTelemetryServiceName;
}

export function createGatewayTelemetryProducerSafetyContract(): GatewayTelemetryProducerSafetyContract {
	if (
		gatewayTelemetryAdmissionLimits.maxExportBatchRecords >
		gatewayTelemetryAdmissionLimits.maxQueuedRecordsPerSignal
	) {
		throw new Error(
			'Gateway telemetry maxExportBatchRecords must not exceed maxQueuedRecordsPerSignal.',
		);
	}
	return {
		admissionLimits: { ...gatewayTelemetryAdmissionLimits },
		sourcePolicy: { ...gatewayTelemetrySourcePolicy },
	};
}

export interface GatewayZoneObservabilityConfig {
	readonly mode: 'collector';
	readonly collector: {
		readonly host: string;
		readonly grpcPort: number;
		readonly httpPort: number;
		readonly targetHost: string;
		readonly targetGrpcPort: number;
		readonly targetHttpPort: number;
	};
	readonly framework: GatewayFrameworkTelemetryProducerConfig;
	readonly openclaw?: {
		readonly diagnosticsFlags: readonly string[];
	};
	readonly toolPortal: GatewayToolPortalTelemetryProducerConfig;
}

/**
 * Zone config as the lifecycle sees it.
 * Decoupled from SystemConfig — the controller maps into this shape.
 */
export interface GatewayZoneConfig {
	readonly id: string;
	readonly agents?: readonly GatewayZoneAgentConfig[];
	readonly gateway: GatewayZoneGatewayConfig;
	readonly toolPortal?: GatewayZoneMcpPortalConfig;
	readonly runtimeMcpServers?: Readonly<Record<string, GatewayZoneMcpServerConfig>>;
	readonly runtimeMediatedSecrets?: Readonly<Record<string, MediatedSecretSpec>>;
	readonly runtimeEnvironment?: Readonly<Record<string, string>>;
	readonly runtimePrivateEnvironment?: Readonly<
		Partial<Record<GatewayControlPrivateEnvironmentName, string>>
	>;
	readonly runtimePluginConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly gitReadAllowlistRepos?: readonly string[];
	readonly observability?: GatewayZoneObservabilityConfig;
	readonly secrets: Readonly<Record<string, GatewaySecretConfig>>;
	readonly egressHosts: readonly EgressHostConfig[];
	readonly websocketUpgrades?: readonly WebSocketUpgradeConfig[];
	readonly defaultToolVmProfile?: string;
}

export interface GatewayZoneAgentConfig {
	readonly id: string;
	readonly toolVmProfile?: string | undefined;
}

export interface GatewayZoneMcpPortalConfig {
	readonly configDir: string;
}

export interface GatewayZoneMcpServerConfig {
	readonly headers?: Readonly<Record<string, string>>;
	readonly transport: 'streamable-http';
	readonly url: string;
}

export interface BuildGatewayVmRequirementsOptions {
	readonly controllerPort: number;
	readonly gatewayCacheDir: string;
	readonly projectNamespace: string;
	readonly resolvedSecrets: Record<string, string>;
	readonly runtimeDir: string;
	readonly tcpPool: {
		readonly basePort: number;
		readonly size: number;
	};
	readonly zone: GatewayZoneConfig;
}

export interface GatewayLifecycleBase {
	/**
	 * How to run interactive auth for this gateway type.
	 * Absent means the gateway type does not support interactive auth.
	 */
	readonly authConfig?: GatewayAuthConfig | undefined;

	/**
	 * Build backend-neutral guest workload requirements.
	 * Pure data assembly — no side effects or controller authority.
	 */
	buildVmRequirements(options: BuildGatewayVmRequirementsOptions): GatewayVmRequirements;

	/**
	 * Optional hook to prepare host-side state before the VM boots.
	 * Example: writing auth-profiles.json from 1Password.
	 */
	prepareHostState?(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void>;

	/**
	 * Optional hook to resolve host-state secret dependencies without writing
	 * host state. Protected restarts use this before closing a live gateway so
	 * secret-resolution failures do not strand the zone without a VM.
	 */
	preflightHostState?(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void>;
}

export interface BuildManagedFrameworkServiceBootInputsOptions {
	readonly resolvedSecrets: Record<string, string>;
	readonly zone: GatewayZoneConfig;
}

/**
 * Sensitive framework-service inputs that the controller materializes into
 * the protected, immutable Managed Gateway boot-input directory.
 *
 * This contract intentionally contains no executable, argv, callback,
 * process handle, or controller authority.
 */
interface ManagedFrameworkServiceBootInputsBase {
	readonly configuration: unknown;
	readonly environment: Readonly<Record<string, string>>;
}

interface ManagedFrameworkServiceConfigurationOnlyBootInputs extends ManagedFrameworkServiceBootInputsBase {
	readonly kind: 'configuration-only';
}

interface ManagedHermesFrameworkServiceBootInputs extends ManagedFrameworkServiceBootInputsBase {
	readonly kind: 'hermes-managed-scope';
	readonly managedConfigurationSource: string;
}

export type ManagedFrameworkServiceBootInputs =
	| ManagedFrameworkServiceConfigurationOnlyBootInputs
	| ManagedHermesFrameworkServiceBootInputs;

export interface ManagedGatewayLifecycle extends GatewayLifecycleBase {
	readonly executionModel: 'managed-gateway';

	/** Build the selected framework half of the exact managed boot contract. */
	buildFrameworkServiceBootMetadata(zone: GatewayZoneConfig): ManagedFrameworkServiceBootMetadata;

	/** Build service-scoped config and environment for protected materialization. */
	buildFrameworkServiceBootInputs(
		options: BuildManagedFrameworkServiceBootInputsOptions,
	): Promise<ManagedFrameworkServiceBootInputs>;
}

export interface DirectProcessGatewayLifecycle extends GatewayLifecycleBase {
	readonly executionModel: 'direct-process';

	/**
	 * Build the direct-process spec retained only by standalone Worker.
	 * Pure data assembly — no side effects.
	 */
	buildProcessSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
	): GatewayProcessSpec;
}

export type GatewayLifecycle = ManagedGatewayLifecycle | DirectProcessGatewayLifecycle;
