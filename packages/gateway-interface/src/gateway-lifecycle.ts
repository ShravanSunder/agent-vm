import type { MediatedSecretSpec, SecretResolver } from '@agent-vm/secret-management';

import type { EgressHostConfig, VmAudience } from './audience.js';
import type { GatewayProcessSpec } from './gateway-process-spec.js';
import type { GatewayType } from './gateway-runtime-contract.js';
import type { GatewayVmSpec } from './gateway-vm-spec.js';

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
			readonly setDefault?: boolean;
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
	readonly authProfilesRef?:
		| ConfigGatewayAuthProfilesRef
		| OnePasswordGatewayAuthProfilesRef
		| EnvironmentGatewayAuthProfilesRef
		| undefined;
}

interface OpenClawGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'openclaw';
	readonly controlAuth: OpenClawGatewayControlAuthConfig;
	readonly zoneFilesDir: string;
	readonly authProfilesByAgent?: Readonly<
		Record<
			string,
			| ConfigGatewayAuthProfilesRef
			| OnePasswordGatewayAuthProfilesRef
			| EnvironmentGatewayAuthProfilesRef
		>
	>;
	readonly rawEnvSecrets?: readonly string[];
}

interface WorkerGatewayZoneGatewayConfig extends GatewayZoneBaseGatewayConfig {
	readonly type: 'worker';
}

type GatewayZoneGatewayConfig = OpenClawGatewayZoneGatewayConfig | WorkerGatewayZoneGatewayConfig;

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

/**
 * Zone config as the lifecycle sees it.
 * Decoupled from SystemConfig — the controller maps into this shape.
 */
export interface GatewayZoneConfig {
	readonly id: string;
	readonly agents?: readonly GatewayZoneAgentConfig[];
	readonly gateway: GatewayZoneGatewayConfig;
	readonly mcpPortal?: GatewayZoneMcpPortalConfig;
	readonly runtimeMcpServers?: Readonly<Record<string, GatewayZoneMcpServerConfig>>;
	readonly runtimeMediatedSecrets?: Readonly<Record<string, MediatedSecretSpec>>;
	readonly runtimeEnvironment?: Readonly<Record<string, string>>;
	readonly runtimePluginConfigs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly secrets: Readonly<Record<string, GatewaySecretConfig>>;
	readonly egressHosts: readonly EgressHostConfig[];
	readonly websocketBypass: readonly string[];
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

export interface BuildGatewayVmSpecOptions {
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

export interface GatewayLifecycle {
	/**
	 * How to run interactive auth for this gateway type.
	 * Absent means the gateway type does not support interactive auth.
	 */
	readonly authConfig?: GatewayAuthConfig | undefined;

	/**
	 * Build the full VM spec — everything Gondolin needs to create the VM.
	 * Pure data assembly — no side effects.
	 */
	buildVmSpec(options: BuildGatewayVmSpecOptions): GatewayVmSpec;

	/**
	 * Build the process spec — everything about startup, health, and logging.
	 * Pure data assembly — no side effects.
	 */
	buildProcessSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
	): GatewayProcessSpec;

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
