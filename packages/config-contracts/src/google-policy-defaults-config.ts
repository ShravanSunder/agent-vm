import { googleServicePolicyDefaultsSchema } from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

const googlePolicyCollectionReferenceSchema = z
	.object({
		kind: z.literal('collection'),
		collectionId: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u),
		version: z.string().min(1).max(128),
	})
	.strict();

export const googleConsentRecommendationConfigSchema = z.discriminatedUnion('kind', [
	googlePolicyCollectionReferenceSchema,
	z
		.object({
			kind: z.literal('explicit'),
			groupIds: z
				.array(z.string().regex(/^[a-z][a-z0-9.-]*$/u))
				.max(128)
				.readonly()
				.refine(
					(groupIds) => new Set(groupIds).size === groupIds.length,
					'Consent recommendation groups must be unique.',
				),
		})
		.strict(),
]);
export type GoogleConsentRecommendationConfig = z.infer<
	typeof googleConsentRecommendationConfigSchema
>;

/** Profile application defaults are one collection OR one explicit service map. */
export const googlePolicyDefaultsConfigSchema = z.discriminatedUnion('kind', [
	googlePolicyCollectionReferenceSchema,
	z
		.object({
			kind: z.literal('explicit'),
			services: googleServicePolicyDefaultsSchema,
		})
		.strict(),
]);
export type GooglePolicyDefaultsConfig = z.infer<typeof googlePolicyDefaultsConfigSchema>;

export const managedGoogleNamespaceCallPolicySchema = z
	.object({ source: z.literal('managed_google_policy') })
	.strict();
