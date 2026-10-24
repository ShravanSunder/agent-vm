import { z } from 'zod';

export const agentRegistrationMetadataSchema = z.strictObject({
	kind: z.literal('agent'),
	organizationId: z.uuid(),
});
export type AgentRegistrationMetadata = z.infer<typeof agentRegistrationMetadataSchema>;

export const agentRegistrationSchema = z.strictObject({
	clientId: z.string().min(1),
	metadata: agentRegistrationMetadataSchema,
	grantTypes: z.tuple([z.literal('client_credentials')]),
	clientCredentialsScopes: z.tuple([z.literal('tool-portal:agent')]),
	tokenEndpointAuthMethod: z.literal('client_secret_basic'),
	resourceIds: z.array(z.string().min(1)),
	disabled: z.boolean(),
	registrationComplete: z.boolean(),
});
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;

/** An enabled, complete client is permitted only for one of its linked resource audiences. */
export function agentRegistrationAllowsToken(props: {
	readonly registration: AgentRegistration;
	readonly clientId: string;
	readonly audience: string;
	readonly signedOrganizationId: string;
}): boolean {
	return (
		props.registration.clientId === props.clientId &&
		!props.registration.disabled &&
		props.registration.registrationComplete &&
		props.registration.resourceIds.includes(props.audience) &&
		props.registration.metadata.organizationId === props.signedOrganizationId
	);
}

export const agentClientChangeSchema = z.strictObject({
	requestId: z.uuid(),
	organizationId: z.uuid(),
});
export const workspaceAgentChangeSchema = agentClientChangeSchema.extend({ workspaceId: z.uuid() });
export const agentManagementOperationSchema = z.discriminatedUnion('kind', [
	workspaceAgentChangeSchema.extend({ kind: z.literal('registerAndLink') }),
	workspaceAgentChangeSchema.extend({ kind: z.literal('link'), clientId: z.string().min(1) }),
	workspaceAgentChangeSchema.extend({ kind: z.literal('unlink'), clientId: z.string().min(1) }),
	agentClientChangeSchema.extend({ kind: z.literal('disable'), clientId: z.string().min(1) }),
]);
export type AgentManagementOperation = z.infer<typeof agentManagementOperationSchema>;
export type AgentClientChange = z.infer<typeof agentClientChangeSchema>;
export type AgentManagementFailure =
	| { readonly kind: 'incomplete'; readonly clientId: string }
	| {
			readonly kind: 'refused';
			readonly reason:
				| 'not-owner'
				| 'foreign-organization'
				| 'invalid-client'
				| 'resource-conflict'
				| 'operation-conflict'
				| 'human-check-not-implemented';
	  };
export type AgentClientChangeResult =
	| { readonly kind: 'registered'; readonly clientId: string; readonly clientSecret: string }
	| { readonly kind: 'disabled'; readonly clientId: string }
	| AgentManagementFailure;
export interface WorkspaceClientReadback {
	readonly clientId: string;
	readonly workspaceId: string;
	readonly resource: string;
}
export type RegisterAndLinkResult =
	| (WorkspaceClientReadback & { readonly kind: 'registered'; readonly clientSecret: string })
	| AgentManagementFailure;
export type LinkResult =
	| (WorkspaceClientReadback & { readonly kind: 'linked' })
	| AgentManagementFailure;
export type UnlinkResult =
	| (WorkspaceClientReadback & { readonly kind: 'unlinked' })
	| AgentManagementFailure;
export type DisableResult =
	| { readonly kind: 'disabled'; readonly clientId: string }
	| AgentManagementFailure;
export type AgentManagementResult =
	| RegisterAndLinkResult
	| LinkResult
	| UnlinkResult
	| DisableResult;
