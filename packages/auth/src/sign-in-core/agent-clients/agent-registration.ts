import { z } from 'zod';

export const agentRegistrationMetadataSchema = z.strictObject({
	botId: z.uuid(),
	organizationId: z.uuid(),
});
export type AgentRegistrationMetadata = z.infer<typeof agentRegistrationMetadataSchema>;

export const agentRegistrationSchema = z.strictObject({
	clientId: z.string().min(1),
	metadata: agentRegistrationMetadataSchema,
	grantTypes: z.tuple([z.literal('client_credentials')]),
	clientCredentialsScopes: z.tuple([z.literal('tool-portal:agent')]),
	tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'private_key_jwt']),
	disabled: z.boolean(),
});
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;

/** Credential state proves the bot; central alone decides its workspace or collaboration grant. */
export function agentRegistrationAllowsToken(props: {
	readonly registration: AgentRegistration;
	readonly clientId: string;
	readonly signedOrganizationId: string;
}): boolean {
	return (
		props.registration.clientId === props.clientId &&
		!props.registration.disabled &&
		props.registration.metadata.organizationId === props.signedOrganizationId
	);
}
