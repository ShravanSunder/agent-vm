import { describe, expect, it } from 'vitest';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import type { AgentLeaseOperationIdentity } from './agent-lease-operation-lock.js';
import type { StableToolVmLeasePrincipal } from './tool-vm-lease-authority-contracts.js';
import { createToolVmLeaseCreationRegistry } from './tool-vm-lease-creation-registry.js';

const GATEWAY_ONE = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const GATEWAY_TWO = {
	...GATEWAY_ONE,
	gatewayVmId: 'gateway-vm-2',
} satisfies GatewayEpochIdentity;

const MAIN_AGENT_GATEWAY_ONE = {
	agentId: 'main',
	gateway: GATEWAY_ONE,
} satisfies AgentLeaseOperationIdentity;

const PROFILE_ASSIGNMENT_REVISION_A = {
	agentId: MAIN_AGENT_GATEWAY_ONE.agentId,
	frameworkIdentity: { kind: 'hermes' as const, profileName: MAIN_AGENT_GATEWAY_ONE.agentId },
	profileAssignmentRevision: 'assignment-main-v1',
	toolPortalProfileId: 'standard',
} satisfies StableToolVmLeasePrincipal;

const PROFILE_ASSIGNMENT_REVISION_B = {
	...PROFILE_ASSIGNMENT_REVISION_A,
	profileAssignmentRevision: 'assignment-main-v2',
} satisfies StableToolVmLeasePrincipal;

function creationIdentityForProfileAssignment(
	principal: StableToolVmLeasePrincipal,
): AgentLeaseOperationIdentity {
	return {
		agentId: principal.agentId,
		gateway: GATEWAY_ONE,
	};
}

describe('createToolVmLeaseCreationRegistry', () => {
	it('collapses profile-assignment revisions to one Gateway-agent transition identity', () => {
		// Arrange
		const creationRegistry = createToolVmLeaseCreationRegistry();
		const finishRevisionACreation = creationRegistry.trackCreation(
			creationIdentityForProfileAssignment(PROFILE_ASSIGNMENT_REVISION_A),
		);
		const finishRevisionBCreation = creationRegistry.trackCreation(
			creationIdentityForProfileAssignment(PROFILE_ASSIGNMENT_REVISION_B),
		);

		// Act
		const inFlightAgentIdentities = creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE);

		// Assert
		expect(inFlightAgentIdentities).toEqual([MAIN_AGENT_GATEWAY_ONE]);

		// Act
		finishRevisionACreation();

		// Assert
		expect(creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE)).toEqual([
			MAIN_AGENT_GATEWAY_ONE,
		]);

		// Act
		finishRevisionBCreation();

		// Assert
		expect(creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('keeps the same agent under different exact Gateways distinct', () => {
		// Arrange
		const creationRegistry = createToolVmLeaseCreationRegistry();
		const finishGatewayOneCreation = creationRegistry.trackCreation(MAIN_AGENT_GATEWAY_ONE);
		const finishGatewayTwoCreation = creationRegistry.trackCreation({
			agentId: MAIN_AGENT_GATEWAY_ONE.agentId,
			gateway: GATEWAY_TWO,
		});

		// Act
		const gatewayOneIdentities = creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE);
		const gatewayTwoIdentities = creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_TWO);

		// Assert
		expect(gatewayOneIdentities).toEqual([MAIN_AGENT_GATEWAY_ONE]);
		expect(gatewayTwoIdentities).toEqual([
			{
				agentId: MAIN_AGENT_GATEWAY_ONE.agentId,
				gateway: GATEWAY_TWO,
			},
		]);

		// Act
		finishGatewayOneCreation();

		// Assert
		expect(creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE)).toEqual([]);
		expect(creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_TWO)).toHaveLength(1);

		// Act
		finishGatewayTwoCreation();

		// Assert
		expect(creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_TWO)).toEqual([]);
	});

	it('keeps distinct agents under the same exact Gateway distinct', () => {
		// Arrange
		const creationRegistry = createToolVmLeaseCreationRegistry();
		const reviewerAgentGatewayOne = {
			agentId: 'reviewer',
			gateway: GATEWAY_ONE,
		} satisfies AgentLeaseOperationIdentity;
		const finishMainCreation = creationRegistry.trackCreation(MAIN_AGENT_GATEWAY_ONE);
		const finishReviewerCreation = creationRegistry.trackCreation(reviewerAgentGatewayOne);

		// Act
		const inFlightAgentIdentities = creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE);

		// Assert
		expect(inFlightAgentIdentities).toEqual([MAIN_AGENT_GATEWAY_ONE, reviewerAgentGatewayOne]);

		// Act
		finishMainCreation();
		finishReviewerCreation();

		// Assert
		expect(creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('finishes tracking idempotently', () => {
		// Arrange
		const creationRegistry = createToolVmLeaseCreationRegistry();
		const finishTracking = creationRegistry.trackCreation(MAIN_AGENT_GATEWAY_ONE);

		// Act
		finishTracking();
		finishTracking();

		// Assert
		expect(creationRegistry.inFlightAgentIdentitiesForGateway(GATEWAY_ONE)).toEqual([]);
	});
});
