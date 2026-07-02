import type { VfsMountSpec } from '@agent-vm/gondolin-adapter';
import type { MediatedSecretSpec } from '@agent-vm/secret-management';

import type { WebSocketUpgradeConfig } from './websocket-upgrade-policy.js';

/**
 * Everything the controller needs to create the Gondolin VM.
 * Lifecycle implementations own the full Gondolin-facing contract.
 */
export interface GatewayVmSpec {
	readonly environment: Record<string, string>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly mediatedSecrets: Record<string, MediatedSecretSpec>;
	readonly tcpHosts: Record<string, string>;
	readonly allowedHosts: readonly string[];
	readonly websocketUpgrades?: readonly WebSocketUpgradeConfig[];
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly runtimeRootfsSize?: string;
	readonly sessionLabel: string;
}
