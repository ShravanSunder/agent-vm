import {
	googleServicePolicyDefaultsSchema,
	oauthApplicationIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

/** Authored defaults are one collection OR one explicit map, never an inheritance chain. */
export const googlePolicyDefaultsConfigSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('collection'),
			collectionId: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u),
			version: z.string().min(1).max(128),
		})
		.strict(),
	z
		.object({
			kind: z.literal('explicit'),
			applications: z.record(oauthApplicationIdSchema, googleServicePolicyDefaultsSchema),
		})
		.strict(),
]);
export type GooglePolicyDefaultsConfig = z.infer<typeof googlePolicyDefaultsConfigSchema>;

export const managedGoogleNamespaceCallPolicySchema = z
	.object({ source: z.literal('managed_google_policy') })
	.strict();
