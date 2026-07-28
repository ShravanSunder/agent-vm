import { isDeepStrictEqual } from 'node:util';

import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';

function sameConfiguredAgents(
	leftAgentIds: readonly string[],
	rightAgentIds: readonly string[],
): boolean {
	return isDeepStrictEqual([...leftAgentIds].toSorted(), [...rightAgentIds].toSorted());
}

export function assertFreshGatewaySuccessor(props: {
	readonly predecessor: GatewayExpectedAdmissionCohort;
	readonly successor: GatewayExpectedAdmissionCohort;
}): void {
	const { predecessor, successor } = props;
	if (
		predecessor.fence.zoneId !== successor.fence.zoneId ||
		predecessor.frameworkIdentity.frameworkKind !== successor.frameworkIdentity.frameworkKind ||
		predecessor.frameworkIdentity.clientKind !== successor.frameworkIdentity.clientKind ||
		predecessor.frameworkIdentity.projectionCohortDigest !==
			successor.frameworkIdentity.projectionCohortDigest ||
		!sameConfiguredAgents(
			predecessor.frameworkIdentity.configuredAgentIds,
			successor.frameworkIdentity.configuredAgentIds,
		)
	) {
		throw new Error(
			'Gateway successor changed the selected zone, framework, client, projection cohort, or agent set.',
		);
	}
	const reusedIdentityFields: string[] = [];
	if (predecessor.fence.gatewayEpoch === successor.fence.gatewayEpoch) {
		reusedIdentityFields.push('gateway epoch');
	}
	if (predecessor.fence.vmId === successor.fence.vmId) reusedIdentityFields.push('VM id');
	if (predecessor.toolPortalIdentity.processEpoch === successor.toolPortalIdentity.processEpoch) {
		reusedIdentityFields.push('Tool Portal process epoch');
	}
	if (predecessor.toolPortalIdentity.runtimeEpoch === successor.toolPortalIdentity.runtimeEpoch) {
		reusedIdentityFields.push('runtime epoch');
	}
	if (predecessor.frameworkIdentity.frameworkEpoch === successor.frameworkIdentity.frameworkEpoch) {
		reusedIdentityFields.push('framework epoch');
	}
	if (predecessor.controlIdentity.generationId === successor.controlIdentity.generationId) {
		reusedIdentityFields.push('control generation');
	}
	if (predecessor.controlIdentity.processEpoch === successor.controlIdentity.processEpoch) {
		reusedIdentityFields.push('control process epoch');
	}
	if (reusedIdentityFields.length > 0) {
		throw new Error(
			`Gateway successor reused predecessor identity: ${reusedIdentityFields.join(', ')}.`,
		);
	}
}
