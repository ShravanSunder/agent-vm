import type { SecretResolver } from '@agent-vm/gondolin-adapter';

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
			readonly setDefault?: boolean;
		},
	) => string;
}

/**
 * Zone config as the lifecycle sees it.
 * Decoupled from SystemConfig — the controller maps into this shape.
 */
export interface GatewayZoneConfig {
	readonly id: string;
	readonly gateway: {
		readonly type: GatewayType;
		readonly memory: string;
		readonly cpus: number;
		readonly port: number;
		readonly config: string;
		readonly stateDir: string;
		readonly workspaceDir: string;
		readonly authProfilesRef?:
			| {
					readonly source: '1password';
					readonly ref: string;
			  }
			| {
					readonly source: 'environment';
					readonly envVar: string;
			  }
			| undefined;
	};
	readonly secrets: Record<
		string,
		| {
				readonly source: '1password';
				readonly ref: string;
				readonly injection: 'env' | 'http-mediation';
				readonly hosts?: readonly string[] | undefined;
		  }
		| {
				readonly source: 'environment';
				readonly envVar: string;
				readonly injection: 'env' | 'http-mediation';
				readonly hosts?: readonly string[] | undefined;
		  }
	>;
	readonly allowedHosts: readonly string[];
	readonly websocketBypass: readonly string[];
	readonly toolProfile?: string;
}

export interface BuildGatewayVmSpecOptions {
	readonly controllerPort: number;
	readonly projectNamespace: string;
	readonly resolvedSecrets: Record<string, string>;
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
}
