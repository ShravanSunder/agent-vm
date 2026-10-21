import {
	compactVerify,
	createRemoteJWKSet,
	customFetch,
	decodeProtectedHeader,
	type FetchImplementation,
} from 'jose';
import { z } from 'zod';

/** E10 access-token claims; unrelated issuer claims are allowed and ignored. */
export const agentTokenClaimsSchema = z.looseObject({
	iss: z.url(),
	sub: z.string().min(1),
	aud: z.string().min(1),
	exp: z.number().int(),
	iat: z.number().int(),
	scope: z.string(),
	client_id: z.string().min(1),
	azp: z.string().min(1),
	jti: z.string().min(1),
	organization_id: z.uuid(),
});
export type AgentTokenClaims = z.infer<typeof agentTokenClaimsSchema>;

export const agentProofSchema = z.strictObject({
	deployment: z.url(),
	clientId: z.string().min(1),
	organizationId: z.uuid(),
	audience: z.string().min(1),
	expiresAt: z.number().int(),
});
export type AgentProof = z.infer<typeof agentProofSchema>;

export type AgentProofRefusal =
	| 'wrong-token-type'
	| 'bad-signature'
	| 'wrong-issuer'
	| 'wrong-audience'
	| 'expired'
	| 'not-an-agent'
	| 'wrong-scope';
export type AgentProofVerification =
	| { readonly kind: 'verified'; readonly proof: AgentProof }
	| { readonly kind: 'refused'; readonly reason: AgentProofRefusal };
export interface AgentTokenVerifier {
	readonly verify: (token: string) => Promise<AgentProofVerification>;
}

/** Only this boundary reads raw claims. Membership remains the relying service's check. */
export function createAgentTokenVerifier(props: {
	readonly deployment: string;
	readonly audience: string;
	readonly jwksUrl: URL;
	readonly now?: () => number;
	readonly jwksFetch?: FetchImplementation;
}): AgentTokenVerifier {
	const keys = createRemoteJWKSet(
		props.jwksUrl,
		props.jwksFetch === undefined ? {} : { [customFetch]: props.jwksFetch },
	);
	return {
		async verify(token: string): Promise<AgentProofVerification> {
			try {
				if (decodeProtectedHeader(token).typ !== 'at+jwt')
					return { kind: 'refused', reason: 'wrong-token-type' };
			} catch {
				return { kind: 'refused', reason: 'wrong-token-type' };
			}
			let claims: Record<string, unknown>;
			try {
				// Verify the signature first, then apply E10's ordered claim checks.
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
			if (typeof claims.aud !== 'string' || claims.aud !== props.audience)
				return { kind: 'refused', reason: 'wrong-audience' };
			if (
				typeof claims.exp !== 'number' ||
				!Number.isInteger(claims.exp) ||
				claims.exp <= Math.floor((props.now?.() ?? Date.now()) / 1000)
			)
				return { kind: 'refused', reason: 'expired' };
			if (
				Object.hasOwn(claims, 'sid') ||
				!z.uuid().safeParse(claims.organization_id).success ||
				typeof claims.client_id !== 'string' ||
				claims.sub !== claims.client_id ||
				claims.azp !== claims.client_id
			)
				return { kind: 'refused', reason: 'not-an-agent' };
			if (
				typeof claims.scope !== 'string' ||
				!claims.scope.split(/\s+/u).includes('tool-portal:agent')
			)
				return { kind: 'refused', reason: 'wrong-scope' };
			const parsed = agentTokenClaimsSchema.safeParse(claims);
			if (!parsed.success) return { kind: 'refused', reason: 'not-an-agent' };
			return {
				kind: 'verified',
				proof: {
					deployment: parsed.data.iss,
					clientId: parsed.data.client_id,
					organizationId: parsed.data.organization_id,
					audience: parsed.data.aud,
					expiresAt: parsed.data.exp,
				},
			};
		},
	};
}
