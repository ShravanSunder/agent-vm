import { z } from 'zod';

import {
	createOAuthEnvelopeCodec,
	oauthEnvelopeBindingSchema,
	type OAuthKeyEncryptionKey,
} from '../envelope-codec.js';
import {
	oauthStoredGrantSchema,
	type OAuthStoredGrant,
} from '../oauth-credential-catalog-contracts.js';

export const googleStoredCredentialAuthoritySchema = oauthStoredGrantSchema.pick({
	accountAlias: true,
	authorizationMetadataRevision: true,
	grantedScopes: true,
	requestedScopes: true,
	selectedGroupIds: true,
});
export const googleStoredCredentialPayloadSchema = z
	.object({
		accessToken: z.string().min(1),
		accessTokenExpiresAtMs: z.number().int().positive(),
		authority: googleStoredCredentialAuthoritySchema,
		refreshToken: z.string().min(1),
	})
	.strict();
export type GoogleStoredCredentialPayload = z.infer<typeof googleStoredCredentialPayloadSchema>;

const credentialCodec = createOAuthEnvelopeCodec({
	payloadSchema: googleStoredCredentialPayloadSchema,
});

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

/** Host-only read verification. Discovery and final admission must not refresh tokens. */
export function decryptGoogleCredentialPayload(props: {
	readonly grant: OAuthStoredGrant;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
}): GoogleStoredCredentialPayload {
	const grant = oauthStoredGrantSchema.parse(props.grant);
	if (grant.providerId !== 'google') throw new Error('Expected a Google credential.');
	const payload = credentialCodec.decrypt({
		binding: oauthEnvelopeBindingSchema.strip().parse(grant),
		envelope: grant.envelope,
		keyEncryptionKey: props.keyEncryptionKey,
	});
	const authority = payload.authority;
	if (
		authority.accountAlias !== grant.accountAlias ||
		authority.authorizationMetadataRevision !== grant.authorizationMetadataRevision ||
		!sameStringSet(authority.grantedScopes, grant.grantedScopes) ||
		!sameStringSet(authority.requestedScopes, grant.requestedScopes) ||
		!sameStringSet(authority.selectedGroupIds, grant.selectedGroupIds)
	) {
		throw new Error('Stored OAuth authority hints do not match the authenticated payload.');
	}
	return payload;
}
