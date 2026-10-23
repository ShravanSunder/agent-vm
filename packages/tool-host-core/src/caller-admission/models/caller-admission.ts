import type { AgentProofRefusal } from '@agent-collaboration/tool-access/contracts';

export interface OrganizationAdmission {
	readonly isAgentListed: (agentClientId: string) => Promise<boolean>;
}
export interface OrganizationDirectory {
	readonly forOrganization: (organizationId: string) => OrganizationAdmission;
}
export type HostedCaller = {
	readonly kind: 'verified';
	readonly organizationId: string;
	readonly agentClientId: string;
};
export type HostedCallerCheck =
	| HostedCaller
	| {
			readonly kind: 'refused';
			readonly reason: AgentProofRefusal | 'missing-token' | 'removed-agent' | 'profile-unassigned';
	  }
	| { readonly kind: 'unavailable'; readonly reason: 'admission-unavailable' };
