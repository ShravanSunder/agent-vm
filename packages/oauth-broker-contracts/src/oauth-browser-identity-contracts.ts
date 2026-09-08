import { z } from 'zod';

export const oauthBrowserOwnerIdentitySchema = z
	.object({
		issuer: z.url().max(2048),
		userId: z.string().min(1).max(256),
	})
	.strict();
export type OAuthBrowserOwnerIdentity = z.infer<typeof oauthBrowserOwnerIdentitySchema>;

export const oauthBrowserSessionIdentitySchema = oauthBrowserOwnerIdentitySchema
	.extend({
		sessionId: z.string().min(1).max(256),
	})
	.strict();
export type OAuthBrowserSessionIdentity = z.infer<typeof oauthBrowserSessionIdentitySchema>;

export const oauthBrowserIdentityVerificationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('verified'), identity: oauthBrowserSessionIdentitySchema }).strict(),
	z.object({ kind: z.literal('signed-out') }).strict(),
	z.object({ kind: z.literal('identity-mismatch') }).strict(),
	z.object({ kind: z.literal('verification-unavailable') }).strict(),
]);
export type OAuthBrowserIdentityVerification = z.infer<
	typeof oauthBrowserIdentityVerificationSchema
>;
