import type {
	AgentProofRefusal,
	AgentTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';

export interface OrganizationAdmission {
	readonly isAgentListed: (agentClientId: string) => Promise<boolean>;
}
export interface OrganizationDirectory {
	readonly forOrganization: (organizationId: string) => OrganizationAdmission;
}
export type WorkerCaller = {
	readonly kind: 'verified';
	readonly organizationId: string;
	readonly agentClientId: string;
};
export type WorkerCallerCheck =
	| WorkerCaller
	| {
			readonly kind: 'refused';
			readonly reason: AgentProofRefusal | 'missing-token' | 'removed-agent';
	  }
	| { readonly kind: 'unavailable'; readonly reason: 'admission-unavailable' };

/** The only Worker edge that reads tokens. URL, labels and headers cannot select an organization. */
export async function checkWorkerCaller(props: {
	readonly request: Request;
	readonly verifier: AgentTokenVerifier;
	readonly organizations: OrganizationDirectory;
}): Promise<WorkerCallerCheck> {
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
