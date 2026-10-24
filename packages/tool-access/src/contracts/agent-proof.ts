import {
	compactVerify,
	createRemoteJWKSet,
	customFetch,
	decodeProtectedHeader,
	type FetchImplementation,
} from 'jose';
import { z } from 'zod';

import {
	personaRefSchema,
	principalSchema,
	markSchema,
	workspaceTokenClaimsSchema,
} from '#tool-access/contracts/workspace-token-claims';

export const agentProofSchema = z.strictObject({
	deployment: z.url(),
	clientId: z.string().min(1),
	organizationId: z.uuid(),
	workspaceId: z.uuid(),
	audience: z.string().min(1),
	expiresAt: z.number().int(),
	principal: principalSchema,
	persona: personaRefSchema,
	grantRevision: markSchema,
	grantExpiresAt: z.number().int(),
});
export type AgentProof = z.infer<typeof agentProofSchema>;

export type AgentProofRefusal =
	| 'wrong-token-type'
	| 'bad-signature'
	| 'wrong-issuer'
	| 'wrong-audience'
	| 'expired'
	| 'not-an-agent'
	| 'wrong-scope'
	| 'wrong-workspace';
export type AgentProofVerification =
	| { readonly kind: 'verified'; readonly proof: AgentProof }
	| { readonly kind: 'refused'; readonly reason: AgentProofRefusal };
export interface AgentTokenVerifier {
	readonly verify: (
		token: string,
		expected: { readonly workspaceId: string; readonly audience: string },
	) => Promise<AgentProofVerification>;
}

/** Verify signed workspace claims before projecting the caller's identity and grant. */
export function createAgentTokenVerifier(props: {
	readonly deployment: string;
	readonly jwksUrl: URL;
	readonly now?: () => number;
	readonly jwksFetch?: FetchImplementation;
}): AgentTokenVerifier {
	const keys = createRemoteJWKSet(props.jwksUrl, {
		cacheMaxAge: 300_000,
		cooldownDuration: 0,
		...(props.jwksFetch === undefined ? {} : { [customFetch]: props.jwksFetch }),
	});
	return {
		async verify(
			token: string,
			expected: { readonly workspaceId: string; readonly audience: string },
		): Promise<AgentProofVerification> {
			try {
				if (decodeProtectedHeader(token).typ !== 'at+jwt')
					return { kind: 'refused', reason: 'wrong-token-type' };
			} catch {
				return { kind: 'refused', reason: 'wrong-token-type' };
			}
			let claims: Record<string, unknown>;
			try {
				// Signature verification precedes every claim-based refusal.
				// jwtVerify's built-in time validation would run before the audience check.
				const signed = await compactVerify(token, keys, {
					algorithms: ['RS256', 'ES256', 'EdDSA'],
				});
				claims = z
					.record(z.string(), z.unknown())
					.parse(JSON.parse(new TextDecoder().decode(signed.payload)));
			} catch {
				return { kind: 'refused', reason: 'bad-signature' };
			}
			if (claims.iss !== props.deployment) return { kind: 'refused', reason: 'wrong-issuer' };
			if (typeof claims.aud !== 'string' || claims.aud !== expected.audience)
				return { kind: 'refused', reason: 'wrong-audience' };
			if (
				typeof claims.exp !== 'number' ||
				!Number.isInteger(claims.exp) ||
				claims.exp + 60 <= Math.floor((props.now?.() ?? Date.now()) / 1000) ||
				(typeof claims.grant_expires_at === 'number' &&
					claims.grant_expires_at <= Math.floor((props.now?.() ?? Date.now()) / 1000))
			)
				return { kind: 'refused', reason: 'expired' };
			if (
				Object.hasOwn(claims, 'sid') ||
				!z.uuid().safeParse(claims.organization_id).success ||
				!z.uuid().safeParse(claims.workspace_id).success ||
				typeof claims.client_id !== 'string' ||
				claims.sub !== claims.client_id
			)
				return { kind: 'refused', reason: 'not-an-agent' };
			if (claims.workspace_id !== expected.workspaceId)
				return { kind: 'refused', reason: 'wrong-workspace' };
			if (
				typeof claims.scope !== 'string' ||
				!claims.scope.split(/\s+/u).includes('tool-portal:agent')
			)
				return { kind: 'refused', reason: 'wrong-scope' };
			const parsed = workspaceTokenClaimsSchema.safeParse(claims);
			if (!parsed.success) return { kind: 'refused', reason: 'not-an-agent' };
			return {
				kind: 'verified',
				proof: {
					deployment: parsed.data.iss,
					clientId: parsed.data.client_id,
					organizationId: parsed.data.organization_id,
					workspaceId: parsed.data.workspace_id,
					audience: parsed.data.aud,
					expiresAt: parsed.data.exp,
					principal: parsed.data.principal,
					persona: parsed.data.persona,
					grantRevision: parsed.data.grant_revision,
					grantExpiresAt: parsed.data.grant_expires_at,
				},
			};
		},
	};
}
