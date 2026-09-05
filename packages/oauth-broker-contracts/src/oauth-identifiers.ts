import { z } from 'zod';

const oauthNamedIdentifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const oauthOpaqueIdentifierPattern = /^[A-Za-z0-9_-]{32,256}$/u;
const oauthScopePattern = /^[\u0021-\u007e]{1,512}$/u;

export const oauthProviderIdSchema = z
	.string()
	.regex(oauthNamedIdentifierPattern)
	.brand<'OAuthProviderId'>();
export type OAuthProviderId = z.infer<typeof oauthProviderIdSchema>;

export const oauthApplicationIdSchema = z
	.string()
	.regex(oauthNamedIdentifierPattern)
	.brand<'OAuthApplicationId'>();
export type OAuthApplicationId = z.infer<typeof oauthApplicationIdSchema>;

export const oauthServiceIdSchema = z
	.string()
	.regex(oauthNamedIdentifierPattern)
	.brand<'OAuthServiceId'>();
export type OAuthServiceId = z.infer<typeof oauthServiceIdSchema>;

export const oauthAccountProfileIdSchema = z
	.string()
	.regex(oauthNamedIdentifierPattern)
	.brand<'OAuthAccountProfileId'>();
export type OAuthAccountProfileId = z.infer<typeof oauthAccountProfileIdSchema>;

export const oauthCredentialIdSchema = z.uuid().brand<'OAuthCredentialId'>();
export type OAuthCredentialId = z.infer<typeof oauthCredentialIdSchema>;

export const oauthTransactionIdSchema = z
	.string()
	.regex(oauthOpaqueIdentifierPattern)
	.brand<'OAuthTransactionId'>();
export type OAuthTransactionId = z.infer<typeof oauthTransactionIdSchema>;

export const oauthCompletionSessionIdSchema = z
	.string()
	.regex(oauthOpaqueIdentifierPattern)
	.brand<'OAuthCompletionSessionId'>();
export type OAuthCompletionSessionId = z.infer<typeof oauthCompletionSessionIdSchema>;

export const oauthMaterialRevisionSchema = z
	.string()
	.regex(/^sha256:[A-Za-z0-9_-]{43}$/u)
	.brand<'OAuthMaterialRevision'>();
export type OAuthMaterialRevision = z.infer<typeof oauthMaterialRevisionSchema>;

export const oauthScopeSchema = z
	.string()
	.regex(oauthScopePattern)
	.refine((scope) => !scope.includes('\0'), { message: 'OAuth scopes must not contain NUL.' })
	.brand<'OAuthScope'>();
export type OAuthScope = z.infer<typeof oauthScopeSchema>;
