import type { AgentTokenVerifier } from '@agent-collaboration/tool-access/contracts';

import type {
	OrganizationDirectory,
	HostedCallerCheck,
} from '#tool-host-core/caller-admission/models/caller-admission';

/** The only hosted edge that reads tokens. URL, labels and headers cannot select an organization. */
export async function checkHostedCaller(props: {
	readonly request: Request;
	readonly verifier: AgentTokenVerifier;
	readonly organizations: OrganizationDirectory;
}): Promise<HostedCallerCheck> {
	const authorization = props.request.headers.get('authorization');
	const bearer = authorization?.match(/^Bearer ([^\s]+)$/iu)?.[1];
	if (bearer === undefined) return { kind: 'refused', reason: 'missing-token' };
	const verified = await props.verifier.verify(bearer);
	if (verified.kind === 'refused') return verified;
	const { organizationId, clientId } = verified.proof;
	try {
		if (!(await props.organizations.forOrganization(organizationId).isAgentListed(clientId)))
			return { kind: 'refused', reason: 'removed-agent' };
	} catch {
		return { kind: 'unavailable', reason: 'admission-unavailable' };
	}
	return { kind: 'verified', organizationId, agentClientId: clientId };
}
