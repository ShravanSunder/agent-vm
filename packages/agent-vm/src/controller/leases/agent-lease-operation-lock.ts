import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { gatewayAuthorityKey } from './tool-vm-lease-authority-runtime-identity.js';

export interface AgentLeaseOperationIdentity {
	readonly agentId: string;
	readonly gateway: GatewayEpochIdentity;
}

export interface AgentLeaseOperationLock {
	runExclusive<TValue>(
		identity: AgentLeaseOperationIdentity,
		operation: () => Promise<TValue>,
	): Promise<TValue>;
}

function agentLeaseOperationIdentityKey(identity: AgentLeaseOperationIdentity): string {
	return `${gatewayAuthorityKey(identity.gateway)}\0${identity.agentId}`;
}

export function createAgentLeaseOperationLock(): AgentLeaseOperationLock {
	const pendingOperationsByGatewayAgent = new Map<string, Promise<void>>();

	return {
		async runExclusive<TValue>(
			identity: AgentLeaseOperationIdentity,
			operation: () => Promise<TValue>,
		): Promise<TValue> {
			const identityKey = agentLeaseOperationIdentityKey(identity);
			const previousOperation =
				pendingOperationsByGatewayAgent.get(identityKey) ?? Promise.resolve();
			let releaseCurrentOperation: (() => void) | undefined;
			const currentOperation = new Promise<void>((resolve) => {
				releaseCurrentOperation = resolve;
			});
			pendingOperationsByGatewayAgent.set(identityKey, currentOperation);
			await previousOperation.catch(() => {});
			try {
				return await operation();
			} finally {
				releaseCurrentOperation?.();
				if (pendingOperationsByGatewayAgent.get(identityKey) === currentOperation) {
					pendingOperationsByGatewayAgent.delete(identityKey);
				}
			}
		},
	};
}
