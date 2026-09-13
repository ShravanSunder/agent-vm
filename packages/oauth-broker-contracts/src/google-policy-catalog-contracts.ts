import { z } from 'zod';

import { gogCommandDescriptorSchema, googleCatalogFamilyIdSchema } from './gog-commands.js';
import {
	googleOperationEffectSchema,
	googleServicePolicyDefaultsSchema,
} from './google-account-policy-contracts.js';
import { oauthScopeSchema, oauthServiceIdSchema } from './oauth-identifiers.js';

const groupIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u);
const groupIdsSchema = z
	.array(groupIdSchema)
	.max(64)
	.readonly()
	.refine((ids) => new Set(ids).size === ids.length);
const familySelectionsSchema = z.record(googleCatalogFamilyIdSchema, groupIdsSchema);

/** Code-owned input to configuration compilation; this is not authored OAuth config. */
export const googlePolicyCatalogSchema = z
	.object({
		catalogVersion: z.string().min(1).max(128),
		gogBuildIdentity: z
			.object({ version: z.string().min(1).max(64), commit: z.string().regex(/^[a-f0-9]{40}$/u) })
			.strict(),
		families: z.record(
			googleCatalogFamilyIdSchema,
			z
				.object({
					allowedHosts: z
						.array(z.string().regex(/^[a-z0-9.-]+$/u))
						.min(1)
						.max(32)
						.readonly(),
				})
				.strict(),
		),
		groups: z
			.array(
				z
					.object({
						groupId: groupIdSchema,
						familyId: googleCatalogFamilyIdSchema,
						serviceId: oauthServiceIdSchema,
						effect: googleOperationEffectSchema,
						label: z.string().min(1).max(320),
						warning: z.string().max(2048),
						scopes: z.array(oauthScopeSchema).min(1).max(32).readonly(),
						fileMode: z.enum(['all-files', 'app-files']).optional(),
						operationIds: z.array(z.string().min(1).max(128)).max(512).readonly(),
					})
					.strict(),
			)
			.max(64)
			.readonly(),
		operations: z.array(gogCommandDescriptorSchema).max(512).readonly(),
		ceilingPresets: z.record(z.string().min(1).max(128), familySelectionsSchema),
		collections: z.record(
			z.string().min(1).max(128),
			z
				.object({
					version: z.string().min(1).max(128),
					label: z.string().min(1).max(320),
					summary: z.string().min(1).max(2048),
					rationale: z.string().min(1).max(2048),
					selections: familySelectionsSchema,
					defaults: z.record(googleCatalogFamilyIdSchema, googleServicePolicyDefaultsSchema),
				})
				.strict(),
		),
	})
	.strict();
export type GooglePolicyCatalog = z.infer<typeof googlePolicyCatalogSchema>;
export type GooglePolicyCatalogInput = z.input<typeof googlePolicyCatalogSchema>;
