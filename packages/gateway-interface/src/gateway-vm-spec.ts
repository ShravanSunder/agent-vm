import type { SecretSpec, VfsMountSpec } from '@agent-vm/gondolin-adapter';

/**
 * Everything the controller needs to create the Gondolin VM.
 * Lifecycle implementations own the full Gondolin-facing contract.
 */
export interface GatewayVmSpec {
	readonly environment: Record<string, string>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly mediatedSecrets: Record<string, SecretSpec>;
	readonly tcpHosts: Record<string, string>;
	readonly allowedHosts: readonly string[];
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly sessionLabel: string;
}
