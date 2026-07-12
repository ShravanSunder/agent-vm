import type { GatewayLifecycle, WebSocketUpgradeConfig } from '@agent-vm/gateway-contracts';
import type { ManagedSshEgressOptions, VfsMountSpec } from '@agent-vm/gondolin-adapter';
import type { MediatedSecretSpec } from '@agent-vm/secret-management';

/** Everything a gateway lifecycle supplies to the Gondolin VM adapter. */
export interface GondolinGatewayVmSpec {
	readonly environment: Record<string, string>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly mediatedSecrets: Record<string, MediatedSecretSpec>;
	readonly tcpHosts: Record<string, string>;
	readonly sshEgress?: ManagedSshEgressOptions;
	readonly allowedHosts: readonly string[];
	readonly websocketUpgrades?: readonly WebSocketUpgradeConfig[];
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly runtimeRootfsSize?: string;
	readonly sessionLabel: string;
}

export type GondolinGatewayLifecycle = GatewayLifecycle<GondolinGatewayVmSpec>;
