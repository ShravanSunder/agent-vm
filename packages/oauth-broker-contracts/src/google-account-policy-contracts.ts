import { z } from 'zod';

import { oauthBrowserOwnerIdentitySchema } from './oauth-browser-identity-contracts.js';
import { oauthApplicationIdSchema, oauthServiceIdSchema } from './oauth-identifiers.js';

export const oauthAccountIdSchema = z.uuid().brand<'OAuthAccountId'>();
export const oauthAuthorizationIdSchema = z.uuid().brand<'OAuthAuthorizationId'>();
export const googleOperationEffectSchema = z.enum(['read', 'write']);
export type GoogleOperationEffect = z.infer<typeof googleOperationEffectSchema>;
export const googleCallDispositionSchema = z.enum(['deny', 'ask', 'allow']);
export type GoogleCallDisposition = z.infer<typeof googleCallDispositionSchema>;

export const googlePolicyOverrideCellSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('inherit') }).strict(),
	z.object({ kind: z.literal('explicit'), disposition: googleCallDispositionSchema }).strict(),
]);
export type GooglePolicyOverrideCell = z.infer<typeof googlePolicyOverrideCellSchema>;

export const googleServicePolicyOverridesSchema = z
	.object({
		read: googlePolicyOverrideCellSchema,
		write: googlePolicyOverrideCellSchema,
	})
	.strict();

export const googleAccountPolicyBindingSchema = z
	.object({
		zoneId: z.string().min(1).max(128),
		agentId: z.string().min(1).max(128),
		accountId: oauthAccountIdSchema,
		applicationId: oauthApplicationIdSchema,
		authorizationId: oauthAuthorizationIdSchema,
		owner: oauthBrowserOwnerIdentitySchema,
	})
	.strict();
export type GoogleAccountPolicyBinding = z.infer<typeof googleAccountPolicyBindingSchema>;

export const googleAccountPolicySnapshotSchema = googleAccountPolicyBindingSchema
	.extend({
		format: z.literal(1),
		overrideRevision: z.number().int().positive(),
		state: z.enum(['applying', 'active']),
		lastEditor: oauthBrowserOwnerIdentitySchema.nullable(),
		lastEditedAtMs: z.number().int().nonnegative().nullable(),
		services: z.record(oauthServiceIdSchema, googleServicePolicyOverridesSchema),
	})
	.strict()
	.refine((snapshot) => (snapshot.lastEditor === null) === (snapshot.lastEditedAtMs === null), {
		message: 'Policy editor identity and edit time must be present together.',
	});
export type GoogleAccountPolicySnapshot = z.infer<typeof googleAccountPolicySnapshotSchema>;

export const googleServicePolicyDefaultsSchema = z.record(
	oauthServiceIdSchema,
	z
		.object({
			read: googleCallDispositionSchema.optional(),
			write: googleCallDispositionSchema.optional(),
		})
		.strict(),
);

export const googleServiceEffectsSchema = z.record(
	oauthServiceIdSchema,
	z.array(googleOperationEffectSchema).readonly(),
);

export const googleOperationRequirementsSchema = z
	.array(
		z
			.object({
				serviceId: oauthServiceIdSchema,
				effects: z
					.array(googleOperationEffectSchema)
					.min(1)
					.max(2)
					.readonly()
					.refine((effects) => new Set(effects).size === effects.length, {
						message: 'Operation effects must be unique.',
					}),
			})
			.strict(),
	)
	.min(1)
	.max(32)
	.readonly();

export const googleAccountInvocationPolicyInputSchema = z
	.object({
		binding: googleAccountPolicyBindingSchema,
		// Only the host may supply a decrypted, authenticated snapshot. Schema validation
		// is defense in depth; this pure evaluator does not authenticate ciphertext.
		snapshot: z.unknown(),
		defaults: googleServicePolicyDefaultsSchema,
		maximums: googleServiceEffectsSchema,
		grants: googleServiceEffectsSchema,
		requirements: googleOperationRequirementsSchema,
		commandAllowed: z.boolean(),
	})
	.strict();
export type GoogleAccountInvocationPolicyInput = z.input<
	typeof googleAccountInvocationPolicyInputSchema
>;

export const googleAccountInvocationPolicyResultSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unavailable') }).strict(),
	z.object({ kind: z.literal('consent-required') }).strict(),
	z
		.object({ kind: z.literal('denied'), reason: z.enum(['command', 'hard-limit', 'policy']) })
		.strict(),
	z
		.object({
			kind: z.literal('allowed'),
			disposition: z.enum(['ask', 'allow']),
			overrideRevision: z.number().int().positive(),
		})
		.strict(),
]);
export type GoogleAccountInvocationPolicyResult = z.infer<
	typeof googleAccountInvocationPolicyResultSchema
>;
