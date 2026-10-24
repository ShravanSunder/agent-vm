import {
	workspaceResourceIdentifier,
	type AgentTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';

import type {
	WorkspaceDirectory,
	HostedCallerCheck,
} from '#tool-host-core/caller-admission/models/caller-admission';

/** The address selects the workspace; only configured origin and signed claims authorize it. */
export async function checkHostedCaller(props: {
	readonly request: Request;
	readonly workspaceId: string;
	readonly toolPortalOrigin: string;
	readonly verifier: AgentTokenVerifier;
	readonly workspaces: WorkspaceDirectory;
}): Promise<HostedCallerCheck> {
	const bearer = props.request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/iu)?.[1];
	if (bearer === undefined) return { kind: 'refused', reason: 'missing-token' };
	const verified = await props.verifier.verify(bearer, {
		workspaceId: props.workspaceId,
		audience: workspaceResourceIdentifier(props),
	});
	if (verified.kind === 'refused') return verified;
	const { organizationId, clientId } = verified.proof;
	try {
		const membership = await props.workspaces
			.forWorkspace(props.workspaceId)
			.readMembership(clientId);
		if (membership === null) return { kind: 'refused', reason: 'removed-agent' };
		return {
			kind: 'verified',
			organizationId,
			workspaceId: props.workspaceId,
			agentClientId: clientId,
			persona: membership.persona,
		};
	} catch {
		return { kind: 'unavailable', reason: 'admission-unavailable' };
	}
}
