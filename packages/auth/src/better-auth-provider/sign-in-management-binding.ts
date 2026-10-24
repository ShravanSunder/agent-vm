import {
	createPersonTokenVerifier,
	type PersonProof,
} from '@agent-collaboration/tool-access/contracts';

import { manageAgentClient } from '#auth/better-auth-provider/agent-client-management';
import type { ManagementObserver } from '#auth/better-auth-provider/provider-configuration';
import {
	createSignInHttpHandler,
	type SignInHttpConfiguration,
} from '#auth/better-auth-provider/sign-in-http-handler';
import { createAgentRegistrationStore } from '#auth/d1-persistence/agent-registration-store';
import { createPersonAdmissionStore } from '#auth/d1-persistence/person-admission-store';
import type { AgentClientChangeResult } from '#auth/sign-in-core/agent-clients/agent-registration';

/** Internal named-entrypoint implementation. Public HTTP never dispatches these methods. */
export function createSignInManagementBinding(
	configuration: SignInHttpConfiguration,
	controls: {
		readonly observeManagement?: ManagementObserver;
	} = {},
): {
	readonly humanCheckStatus: () => Promise<
		| { readonly kind: 'ready'; readonly level: 'remembered-login' }
		| {
				readonly kind: 'not-implemented';
				readonly level: 'fresh-verified-uv' | 'exact-operation-binding';
		  }
	>;
	readonly isLiveOwner: (props: {
		readonly token: string;
		readonly organizationId: string;
	}) => Promise<boolean>;
	readonly ownsAgentClient: (props: {
		readonly token: string;
		readonly organizationId: string;
		readonly clientId: string;
	}) => Promise<boolean>;
	readonly changeClient: (props: {
		readonly token: string;
		readonly operation: unknown;
	}) => Promise<AgentClientChangeResult>;
} {
	const publicHandler = createSignInHttpHandler(configuration);
	const verifier = createPersonTokenVerifier({
		deployment: configuration.configuration.issuer,
		audience: configuration.configuration.managementAudience,
		jwksUrl: new URL('/api/auth/jwks', configuration.configuration.issuer),
		now: configuration.now,
		// Verify against the actual public JWKS produced by this deployment's Better Auth database.
		jwksFetch: async (input, init) => publicHandler(new Request(input, init)),
	});
	const persons = createPersonAdmissionStore({
		database: configuration.database,
		ownerEmail: configuration.configuration.ownerEmail,
		now: configuration.now,
	});
	async function ownerProof(token: string): Promise<PersonProof | null> {
		if (configuration.configuration.managementHumanCheck !== 'remembered-login') return null;
		const result = await verifier.verify(token);
		if (
			result.kind !== 'verified' ||
			(await persons.readOwnerSession(result.proof.subject, result.proof.sessionRef)) === null
		)
			return null;
		return result.proof;
	}
	return {
		async humanCheckStatus() {
			const level = configuration.configuration.managementHumanCheck;
			return level === 'remembered-login'
				? { kind: 'ready', level }
				: { kind: 'not-implemented', level };
		},
		async isLiveOwner({ token, organizationId }): Promise<boolean> {
			return (
				configuration.configuration.organizationIds.includes(organizationId) &&
				(await ownerProof(token)) !== null
			);
		},
		async ownsAgentClient({ token, organizationId, clientId }): Promise<boolean> {
			if (
				!configuration.configuration.organizationIds.includes(organizationId) ||
				(await ownerProof(token)) === null
			)
				return false;
			return (
				(await createAgentRegistrationStore(configuration).read(clientId))?.metadata
					.organizationId === organizationId
			);
		},
		async changeClient({ token, operation }): Promise<AgentClientChangeResult> {
			if (configuration.configuration.managementHumanCheck !== 'remembered-login')
				return { kind: 'refused', reason: 'human-check-not-implemented' };
			const proof = await ownerProof(token);
			if (proof === null) return { kind: 'refused', reason: 'not-owner' };
			return manageAgentClient({
				provider: { ...configuration, requestState: { createdUserIds: [], issuedSessions: [] } },
				proof,
				operation,
				...(controls.observeManagement === undefined
					? {}
					: { observeManagement: controls.observeManagement }),
			});
		},
	};
}
