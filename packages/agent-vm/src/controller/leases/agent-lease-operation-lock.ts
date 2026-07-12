export interface AgentLeaseIdentity {
	readonly agentId: string;
	readonly zoneId: string;
}

export interface AgentLeaseOperationLock {
	runExclusive<TValue>(
		identity: AgentLeaseIdentity,
		operation: () => Promise<TValue>,
	): Promise<TValue>;
}

function agentLeaseIdentityKey(identity: AgentLeaseIdentity): string {
	return `${identity.zoneId}\0${identity.agentId}`;
}

export function createAgentLeaseOperationLock(): AgentLeaseOperationLock {
	const pendingOperationsByAgent = new Map<string, Promise<void>>();

	return {
		async runExclusive<TValue>(
			identity: AgentLeaseIdentity,
			operation: () => Promise<TValue>,
		): Promise<TValue> {
			const identityKey = agentLeaseIdentityKey(identity);
			const previousOperation = pendingOperationsByAgent.get(identityKey) ?? Promise.resolve();
			let releaseCurrentOperation: (() => void) | undefined;
			const currentOperation = new Promise<void>((resolve) => {
				releaseCurrentOperation = resolve;
			});
			pendingOperationsByAgent.set(identityKey, currentOperation);
			await previousOperation.catch(() => {});
			try {
				return await operation();
			} finally {
				releaseCurrentOperation?.();
				if (pendingOperationsByAgent.get(identityKey) === currentOperation) {
					pendingOperationsByAgent.delete(identityKey);
				}
			}
		},
	};
}
