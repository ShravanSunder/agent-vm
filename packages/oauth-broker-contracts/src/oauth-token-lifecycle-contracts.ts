import { z } from 'zod';

export const oauthTokenLifecycleSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('refreshable'),
			refreshMode: z.enum(['stable-refresh-token', 'rotating-refresh-token']),
		})
		.strict(),
	z
		.object({
			expirationMode: z.enum(['fixed-expiry', 'provider-managed', 'unknown']),
			kind: z.literal('non-refreshable'),
		})
		.strict(),
]);
export type OAuthTokenLifecycle = z.infer<typeof oauthTokenLifecycleSchema>;

export const oauthCredentialLifecycleStateSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('active') }).strict(),
	z
		.object({
			failureClass: z.string().min(1).max(128),
			kind: z.literal('degraded'),
			nextRefreshEligibleAt: z.iso.datetime(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('reauthorization-required'),
			reason: z.enum(['invalid-grant', 'revoked', 'scope-insufficient', 'credential-corrupt']),
		})
		.strict(),
]);
export type OAuthCredentialLifecycleState = z.infer<typeof oauthCredentialLifecycleStateSchema>;
