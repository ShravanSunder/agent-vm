import {
	compactVerify,
	createRemoteJWKSet,
	customFetch,
	decodeProtectedHeader,
	errors,
	type FetchImplementation,
} from 'jose';
import { z } from 'zod';

/** Raw E7 claims; only the verifier may project these into a PersonProof. */
export const personTokenClaimsSchema = z.looseObject({
	iss: z.url(),
	sub: z.string().min(1),
	aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
	exp: z.number().int(),
	iat: z.number().int(),
	scope: z.string(),
	client_id: z.string().min(1),
	azp: z.string().min(1),
	sid: z.string().min(1).optional(),
	jti: z.string().min(1),
});
export type PersonTokenClaims = z.infer<typeof personTokenClaimsSchema>;

export const personProofSchema = z.strictObject({
	issuer: z.url(),
	subject: z.string().min(1),
	audience: z.string().min(1),
	sessionRef: z.string().min(1),
	clientId: z.string().min(1),
	expiresAt: z.number().int(),
});
export type PersonProof = z.infer<typeof personProofSchema>;

export type PersonProofVerification =
	| {
			readonly kind: 'verified';
			readonly proof: PersonProof;
			readonly freshness:
				| { readonly kind: 'signature' }
				| { readonly kind: 'live'; readonly checkedAt: number };
	  }
	| {
			readonly kind: 'refused';
			readonly reason:
				| 'malformed'
				| 'wrong-token-type'
				| 'bad-signature'
				| 'wrong-issuer'
				| 'wrong-audience'
				| 'not-a-person'
				| 'expired'
				| 'inactive';
	  }
	| {
			readonly kind: 'unavailable';
			readonly reason: 'keys-unreachable' | 'introspection-unreachable';
	  };

export interface PersonTokenVerifier {
	readonly verify: (token: string) => Promise<PersonProofVerification>;
}

class PersonProofKeysUnavailable extends Error {}

/** Signature verification alone never authorizes an operation requiring live person/session status. */
export function createPersonTokenVerifier(props: {
	readonly deployment: string;
	readonly audience: string;
	readonly jwksUrl: URL;
	readonly now?: () => number;
	readonly jwksFetch?: FetchImplementation;
}): PersonTokenVerifier {
	const keys = createRemoteJWKSet(
		props.jwksUrl,
		props.jwksFetch === undefined ? {} : { [customFetch]: props.jwksFetch },
	);
	return {
		async verify(token: string): Promise<PersonProofVerification> {
			try {
				if (decodeProtectedHeader(token).typ !== 'at+jwt')
					return { kind: 'refused', reason: 'wrong-token-type' };
			} catch {
				return { kind: 'refused', reason: 'wrong-token-type' };
			}
			let claims: Record<string, unknown>;
			try {
				const signed = await compactVerify(
					token,
					async (header, input) => {
						try {
							return await keys(header, input);
						} catch (error) {
							if (
								error instanceof errors.JWKSNoMatchingKey ||
								error instanceof errors.JOSEAlgNotAllowed
							)
								throw error;
							throw new PersonProofKeysUnavailable();
						}
					},
					{ algorithms: ['RS256', 'ES256', 'EdDSA'] },
				);
				claims = z
					.record(z.string(), z.unknown())
					.parse(JSON.parse(new TextDecoder().decode(signed.payload)));
			} catch (error) {
				if (error instanceof PersonProofKeysUnavailable)
					return { kind: 'unavailable', reason: 'keys-unreachable' };
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
			const sessionRef = z.string().min(1).safeParse(claims.sid);
			if (!sessionRef.success) return { kind: 'refused', reason: 'not-a-person' };
			const parsed = personTokenClaimsSchema.safeParse(claims);
			if (!parsed.success) return { kind: 'refused', reason: 'malformed' };
			return {
				kind: 'verified',
				proof: {
					issuer: parsed.data.iss,
					subject: parsed.data.sub,
					audience: claims.aud,
					sessionRef: sessionRef.data,
					clientId: parsed.data.client_id,
					expiresAt: parsed.data.exp,
				},
				freshness: { kind: 'signature' },
			};
		},
	};
}
