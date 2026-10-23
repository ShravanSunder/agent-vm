import type { PersonProof } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import {
	createSignInProvider,
	type SignInProviderProps,
} from '#auth/better-auth-provider/provider-configuration';
import { createAgentRegistrationStore } from '#auth/d1-persistence/agent-registration-store';
import { createPersonAdmissionStore } from '#auth/d1-persistence/person-admission-store';
import {
	agentClientChangeSchema,
	type AgentClientChangeResult,
} from '#auth/sign-in-core/agent-clients/agent-registration';
import {
	disableAgentClient,
	registerAgentClient,
} from '#auth/sign-in-core/agent-clients/change-agent-client';

const managementOperationSchema = z.discriminatedUnion('kind', [
	agentClientChangeSchema.extend({ kind: z.literal('register') }),
	agentClientChangeSchema.extend({ kind: z.literal('disable'), clientId: z.string().min(1) }),
]);

/** The binding supplies a cryptographically verified proof; no body actor or cookie enters this adapter. */
export async function manageAgentClient(props: {
	readonly provider: Omit<SignInProviderProps, 'authority' | 'generatedClientId'>;
	readonly proof: PersonProof;
	readonly operation: unknown;
}): Promise<AgentClientChangeResult> {
	const operation = managementOperationSchema.parse(props.operation);
	if (!props.provider.configuration.organizationIds.includes(operation.organizationId))
		return { kind: 'refused', reason: 'foreign-organization' };
	const persons = createPersonAdmissionStore({
		database: props.provider.database,
		ownerEmail: props.provider.configuration.ownerEmail,
		now: props.provider.now,
	});
	if ((await persons.readOwnerSession(props.proof.subject, props.proof.sessionRef)) === null)
		return { kind: 'refused', reason: 'not-owner' };
	const clientId =
		operation.kind === 'register'
			? `agent-${operation.organizationId}-${operation.requestId}`
			: operation.clientId;
	const auth = createSignInProvider({
		...props.provider,
		authority: { kind: 'person-proof', proof: props.proof },
		generatedClientId: clientId,
	});
	// Empty internal headers satisfy the library's API contract; caller credentials never get forwarded.
	const headers = new Headers();
	const audience = props.provider.configuration.agentAudience;
	const records = createAgentRegistrationStore(props.provider);
	const ports = {
		records,
		clientId,
		organizationId: operation.organizationId,
		audience,
		actorUserId: props.proof.subject,
		requestId: operation.requestId,
		provider: {
			async create(): Promise<{ clientId: string; clientSecret: string }> {
				const result = await auth.api.adminCreateOAuthClient({
					headers,
					body: {
						client_name: clientId,
						token_endpoint_auth_method: 'client_secret_basic',
						grant_types: ['client_credentials'],
						client_credentials_scopes: ['tool-portal:agent'],
						scope: 'tool-portal:agent',
						metadata: { kind: 'agent', organizationId: operation.organizationId },
					},
				});
				return z
					.object({ client_id: z.string(), client_secret: z.string() })
					.transform((value) => ({ clientId: value.client_id, clientSecret: value.client_secret }))
					.parse(result);
			},
			async link(): Promise<void> {
				await auth.api.adminLinkClientResource({
					headers,
					params: { identifier: audience, client_id: clientId },
				});
			},
			async rotate(): Promise<string> {
				const result = await auth.api.rotateClientSecret({
					headers,
					body: { client_id: clientId },
				});
				return z.object({ client_secret: z.string() }).parse(result).client_secret;
			},
			async disable(): Promise<void> {
				await auth.api.adminUpdateOAuthClient({
					headers,
					body: { client_id: clientId, update: { disabled: true } },
				});
			},
		},
	};
	return operation.kind === 'register' ? registerAgentClient(ports) : disableAgentClient(ports);
}
