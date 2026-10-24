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
	resourceIds: z.tuple([z.string().min(1)]),
	disabled: z.boolean(),
	registrationComplete: z.boolean(),
});
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;

/** Both release fences use the same registration rules; the final fence reads again after signing. */
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
		props.registration.resourceIds[0] === props.audience &&
		props.registration.metadata.organizationId === props.signedOrganizationId
	);
}

export const agentClientChangeSchema = z.strictObject({
	requestId: z.uuid(),
	organizationId: z.uuid(),
});
export type AgentClientChange = z.infer<typeof agentClientChangeSchema>;

export type AgentClientChangeResult =
	| { readonly kind: 'registered'; readonly clientId: string; readonly clientSecret: string }
	| { readonly kind: 'disabled'; readonly clientId: string }
	| { readonly kind: 'incomplete'; readonly clientId: string }
	| {
			readonly kind: 'refused';
			readonly reason:
				| 'not-owner'
				| 'foreign-organization'
				| 'invalid-client'
				| 'human-check-not-implemented';
	  };
