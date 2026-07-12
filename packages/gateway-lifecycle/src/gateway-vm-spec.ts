import type { ManagedVmGitReadOnlySshEgress, ManagedVmMount } from '@agent-vm/managed-vm';
import type { MediatedSecretSpec } from '@agent-vm/secret-management';

import type { WebSocketUpgradeConfig } from './websocket-upgrade-policy.js';

/**
 * Guest workload requirements produced by a gateway lifecycle.
 *
 * Image selection, resources, VM construction, and backend translation remain
 * controller/composition responsibilities.
 */
export interface GatewayVmRequirements {
	readonly environment: Record<string, string>;
	readonly mounts: Record<string, ManagedVmMount>;
	readonly mediatedSecrets: Record<string, MediatedSecretSpec>;
	readonly tcpHosts: Record<string, string>;
	readonly sshEgress?: ManagedVmGitReadOnlySshEgress;
	readonly allowedHosts: readonly string[];
	readonly websocketUpgrades?: readonly WebSocketUpgradeConfig[];
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly runtimeRootfsSize?: string;
	readonly sessionLabel: string;
}
