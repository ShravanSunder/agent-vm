import type { AgentProofRefusal } from '@agent-collaboration/tool-access/contracts';

export interface WorkspaceMembershipRead {
	readonly readMembership: (agentClientId: string) => Promise<{ readonly persona: string } | null>;
}
export interface WorkspaceDirectory {
	readonly forWorkspace: (workspaceId: string) => WorkspaceMembershipRead;
}
export type HostedCaller = {
	readonly kind: 'verified';
	readonly organizationId: string;
	readonly workspaceId: string;
	readonly agentClientId: string;
	readonly persona: string;
};
export type HostedCallerCheck =
	| HostedCaller
	| {
			readonly kind: 'refused';
			readonly reason: AgentProofRefusal | 'missing-token' | 'removed-agent' | 'profile-unassigned';
	  }
	| { readonly kind: 'unavailable'; readonly reason: 'admission-unavailable' };
