import {
	compactVerify,
	createRemoteJWKSet,
	customFetch,
	decodeProtectedHeader,
	type FetchImplementation,
} from 'jose';
import { z } from 'zod';

const serviceClaimsSchema = z.looseObject({
	iss: z.url(),
	aud: z.string().min(1),
	client_id: z.string().min(1),
	scope: z.literal('removal-notices'),
	iat: z.number().int(),
	exp: z.number().int(),
});
export interface RemovalNoticeTokenVerifier {
	readonly verify: (token: string) => Promise<boolean>;
}

/** Only the pinned central client may present this operation's short-lived issuer token. */
export function createRemovalNoticeTokenVerifier(props: {
	readonly issuer: string;
	readonly audience: string;
	readonly clientId: string;
	readonly jwksUrl: URL;
	readonly now?: () => number;
	readonly jwksFetch?: FetchImplementation;
}): RemovalNoticeTokenVerifier {
	const keys = createRemoteJWKSet(props.jwksUrl, {
		cacheMaxAge: 300_000,
		cooldownDuration: 0,
		...(props.jwksFetch === undefined ? {} : { [customFetch]: props.jwksFetch }),
	});
	return {
		verify: async (token) => {
			try {
				if (decodeProtectedHeader(token).typ !== 'at+jwt') return false;
				const verified = await compactVerify(token, keys, {
					algorithms: ['RS256', 'ES256', 'EdDSA'],
				});
				const claims = serviceClaimsSchema.parse(
					JSON.parse(new TextDecoder().decode(verified.payload)),
				);
				const nowSeconds = Math.floor((props.now?.() ?? Date.now()) / 1000);
				return (
					claims.iss === props.issuer &&
					claims.aud === props.audience &&
					claims.client_id === props.clientId &&
					claims.exp > claims.iat &&
					claims.exp - claims.iat <= 300 &&
					claims.iat <= nowSeconds + 60 &&
					nowSeconds < claims.exp + 60
				);
			} catch {
				return false;
			}
		},
	};
}
