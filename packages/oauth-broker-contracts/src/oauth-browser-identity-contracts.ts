import { z } from 'zod';

export const oauthBrowserOwnerIdentitySchema = z
	.object({
		issuer: z.url().max(2048),
		userId: z.string().min(1).max(256),
	})
	.strict();
export type OAuthBrowserOwnerIdentity = z.infer<typeof oauthBrowserOwnerIdentitySchema>;

export const oauthBrowserSessionIdentitySchema = oauthBrowserOwnerIdentitySchema
	.omit({ userId: true })
	.extend({ subject: z.string().min(1).max(256) })
	.strict();
export type OAuthBrowserSessionIdentity = z.infer<typeof oauthBrowserSessionIdentitySchema>;

export const oauthAuthenticatedHumanSchema = z
	.object({
		authenticationExpiresAtMs: z.number().int().positive(),
		emailAddress: z.string().email().max(320).optional(),
		identity: oauthBrowserSessionIdentitySchema,
	})
	.strict();
export type OAuthAuthenticatedHuman = z.infer<typeof oauthAuthenticatedHumanSchema>;
