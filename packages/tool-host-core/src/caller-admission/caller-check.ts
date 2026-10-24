import {
	workspaceResourceIdentifier,
	type AgentTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';

import type { HostedCallerCheck } from '#tool-host-core/caller-admission/models/caller-admission';

/** The address selects the workspace; only configured origin and signed claims authorize it. */
export async function checkHostedCaller(props: {
	readonly request: Request;
	readonly workspaceId: string;
	readonly organizationId: string;
	readonly sessionClientId: string;
	readonly toolPortalOrigin: string;
	readonly verifier: AgentTokenVerifier;
}): Promise<HostedCallerCheck> {
	const bearer = props.request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/iu)?.[1];
	if (bearer === undefined) return { kind: 'refused', reason: 'missing-token' };
	const verified = await props.verifier.verify(bearer, {
		workspaceId: props.workspaceId,
		audience: workspaceResourceIdentifier(props),
	});
	if (verified.kind === 'refused') return verified;
	const proof = verified.proof;
	if (proof.organizationId !== props.organizationId)
		return { kind: 'refused', reason: 'wrong-organization' };
	if (proof.principal.kind === 'fleetHarnessSession' && proof.clientId !== props.sessionClientId)
		return { kind: 'refused', reason: 'wrong-session-client' };
	return {
		kind: 'verified',
		organizationId: proof.organizationId,
		workspaceId: proof.workspaceId,
		principal: proof.principal,
		persona: proof.persona,
		grantRevision: proof.grantRevision,
		grantExpiresAt: proof.grantExpiresAt,
	};
}
