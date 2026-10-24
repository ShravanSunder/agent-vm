import { z } from 'zod';

import {
	agentRegistrationSchema,
	type AgentRegistration,
} from '#auth/sign-in-core/agent-clients/agent-registration';
import type { SignInSqlDatabase } from '#auth/sign-in-core/models/sign-in-database';

function jsonColumn(value: unknown): unknown {
	return typeof value === 'string' ? JSON.parse(value) : value;
}
const clientRowSchema = z.object({
	clientId: z.string(),
	metadata: z.preprocess(jsonColumn, agentRegistrationSchema.shape.metadata),
	grantTypes: z.preprocess(jsonColumn, agentRegistrationSchema.shape.grantTypes),
	clientCredentialsScopes: z.preprocess(
		jsonColumn,
		agentRegistrationSchema.shape.clientCredentialsScopes,
	),
	tokenEndpointAuthMethod: agentRegistrationSchema.shape.tokenEndpointAuthMethod,
	disabled: z.union([z.boolean(), z.literal(0), z.literal(1), z.null()]).transform(Boolean),
});

/** Better Auth owns the credential row. Workspace links never participate in bot identity. */
export function createAgentRegistrationStore(props: { readonly database: SignInSqlDatabase }): {
	readonly read: (clientId: string) => Promise<AgentRegistration | null>;
} {
	return {
		async read(clientId: string): Promise<AgentRegistration | null> {
			const row = await props.database
				.primary()
				.prepare(
					'SELECT clientId, metadata, grantTypes, clientCredentialsScopes, tokenEndpointAuthMethod, disabled FROM oauthClient WHERE clientId = ?',
				)
				.bind(clientId)
				.first();
			if (row === null) return null;
			const parsed = clientRowSchema.safeParse(row);
			return parsed.success ? agentRegistrationSchema.parse(parsed.data) : null;
		},
	};
}
