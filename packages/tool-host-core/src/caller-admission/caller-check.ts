import type { RemovalSubject } from '@agent-collaboration/tool-access/contracts';
import {
	workspaceResourceIdentifier,
	type AgentTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';

import type { HostedCallerCheck } from '#tool-host-core/caller-admission/models/caller-admission';
import type { WorkspaceRemovalRead } from '#tool-host-core/workspace-authority/removal-notice-store';

/** The address selects the workspace; only configured origin and signed claims authorize it. */
export async function checkHostedCaller(props: {
	readonly request: Request;
	readonly workspaceId: string;
	readonly organizationId: string;
	readonly sessionClientId: string;
	readonly toolPortalOrigin: string;
	readonly verifier: AgentTokenVerifier;
	readonly removals: WorkspaceRemovalRead;
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
	const subjects: RemovalSubject[] =
		proof.principal.kind === 'bot'
			? [{ kind: 'bot', botId: proof.principal.bot_id }]
			: [
					{
						kind: 'fleetHarnessSession',
						sessionRef: {
							installation: proof.principal.session_ref.installation,
							harnessEndpoint: proof.principal.session_ref.harness_endpoint,
							conversationId: proof.principal.session_ref.conversation_id,
						},
					},
					{ kind: 'machine', installation: proof.principal.session_ref.installation },
				];
	try {
		const marks = await Promise.all(
			subjects.map(async (subject) => props.removals.readRemovalMark(subject)),
		);
		if (marks.some((mark) => mark !== null && proof.grantRevision < mark))
			return { kind: 'refused', reason: 'removal-covered' };
	} catch {
		return { kind: 'unavailable', reason: 'admission-unavailable' };
	}
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
