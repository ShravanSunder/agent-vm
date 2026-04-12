import type { SecretResolver } from 'gondolin-core';

import type { GatewayProcessSpec } from './gateway-process-spec.js';
import type { GatewayVmSpec } from './gateway-vm-spec.js';

/**
 * Zone config as the lifecycle sees it.
 * Decoupled from SystemConfig — the controller maps into this shape.
 */
export interface GatewayZoneConfig {
	readonly id: string;
	readonly gateway: {
		readonly type: 'openclaw' | 'coding';
		readonly memory: string;
		readonly cpus: number;
		readonly port: number;
		readonly gatewayConfig: string;
		readonly stateDir: string;
		readonly workspaceDir: string;
		readonly authProfilesRef?: string | undefined;
	};
	readonly secrets: Record<
		string,
		{
			readonly source: string;
			readonly ref?: string | undefined;
			readonly injection: 'env' | 'http-mediation';
			readonly hosts?: readonly string[] | undefined;
		}
	>;
	readonly allowedHosts: readonly string[];
	readonly websocketBypass: readonly string[];
	readonly toolProfile: string;
}

export interface GatewayLifecycle {
	/**
	 * Build the full VM spec — everything Gondolin needs to create the VM.
	 * Pure data assembly — no side effects.
	 */
	buildVmSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
		controllerPort: number,
		tcpPool: { readonly basePort: number; readonly size: number },
	): GatewayVmSpec;

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
