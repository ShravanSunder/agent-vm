import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { AgentLeaseOperationIdentity } from './agent-lease-operation-lock.js';

export interface ToolVmLeaseCreationRegistry {
	trackCreation(creation: AgentLeaseOperationIdentity): () => void;
	inFlightAgentIdentitiesForGateway(
		expectedGateway: GatewayEpochIdentity,
	): readonly AgentLeaseOperationIdentity[];
}

export function createToolVmLeaseCreationRegistry(): ToolVmLeaseCreationRegistry {
	const inFlightCreations = new Set<AgentLeaseOperationIdentity>();

	return {
		trackCreation(creation): () => void {
			const trackedCreation = {
				agentId: creation.agentId,
				gateway: structuredClone(creation.gateway),
			};
			inFlightCreations.add(trackedCreation);
			let trackingFinished = false;
			return (): void => {
				if (trackingFinished) {
					return;
				}
				trackingFinished = true;
				inFlightCreations.delete(trackedCreation);
			};
		},
		inFlightAgentIdentitiesForGateway(expectedGateway): readonly AgentLeaseOperationIdentity[] {
			const identitiesByAgentId = new Map<string, AgentLeaseOperationIdentity>();
			for (const creation of inFlightCreations) {
				if (gatewayIdentitiesEqual(creation.gateway, expectedGateway)) {
					identitiesByAgentId.set(creation.agentId, {
						agentId: creation.agentId,
						gateway: structuredClone(creation.gateway),
					});
				}
			}
			return [...identitiesByAgentId.values()];
		},
	};
}
