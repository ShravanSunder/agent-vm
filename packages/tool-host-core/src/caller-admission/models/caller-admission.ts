import type {
	AgentProofRefusal,
	Principal,
	PersonaRef,
} from '@agent-collaboration/tool-access/contracts';

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
	readonly principal: Principal;
	readonly persona: PersonaRef;
	readonly grantRevision: number;
	readonly grantExpiresAt: number;
};
export type HostedCallerCheck =
	| HostedCaller
	| {
			readonly kind: 'refused';
			readonly reason:
				| AgentProofRefusal
				| 'missing-token'
				| 'wrong-organization'
				| 'wrong-session-client'
				| 'profile-unassigned';
	  }
	| { readonly kind: 'unavailable'; readonly reason: 'admission-unavailable' };
