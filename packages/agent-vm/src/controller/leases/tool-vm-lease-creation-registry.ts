import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { AgentLeaseIdentity } from './agent-lease-operation-lock.js';

interface InFlightToolVmLeaseCreation extends AgentLeaseIdentity {
	readonly gatewayIdentity: GatewayEpochIdentity;
}

export interface ToolVmLeaseCreationRegistry {
	trackCreation(creation: InFlightToolVmLeaseCreation): () => void;
	inFlightAgentIdentitiesForGateway(
		expectedGateway: GatewayEpochIdentity,
	): readonly AgentLeaseIdentity[];
}

function agentIdentityKey(identity: AgentLeaseIdentity): string {
	return `${identity.zoneId}\0${identity.agentId}`;
}

export function createToolVmLeaseCreationRegistry(): ToolVmLeaseCreationRegistry {
	const inFlightCreations = new Set<InFlightToolVmLeaseCreation>();

	return {
		trackCreation(creation): () => void {
			const trackedCreation = {
				...creation,
				gatewayIdentity: structuredClone(creation.gatewayIdentity),
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
		inFlightAgentIdentitiesForGateway(expectedGateway): readonly AgentLeaseIdentity[] {
			const identitiesByKey = new Map<string, AgentLeaseIdentity>();
			for (const creation of inFlightCreations) {
				if (gatewayIdentitiesEqual(creation.gatewayIdentity, expectedGateway)) {
					identitiesByKey.set(agentIdentityKey(creation), {
						agentId: creation.agentId,
						zoneId: creation.zoneId,
					});
				}
			}
			return [...identitiesByKey.values()];
		},
	};
}
