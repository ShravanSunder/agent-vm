import {
	oauthAccountIdSchema,
	oauthApplicationIdSchema,
	oauthAuthorizationIdSchema,
	oauthBrowserOwnerIdentitySchema,
	oauthBrowserSessionIdentitySchema,
	oauthCompletionSessionIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	oauthTransactionIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

const agentIdSchema = z.string().min(1).max(128);
export const oauthOpaqueBrowserSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const applicationsSchema = z
	.array(oauthApplicationIdSchema)
	.max(3)
	.readonly()
	.refine(
		(applications) => new Set(applications).size === applications.length,
		'Application IDs must be unique.',
	);
const accountBindingSchema = z
	.object({ accountId: oauthAccountIdSchema, providerSubject: z.string().min(1).max(1024) })
	.strict();
const existingTargetFields = {
	accountId: oauthAccountIdSchema,
	applicationId: oauthApplicationIdSchema,
	authorizationId: oauthAuthorizationIdSchema,
	authorizationMetadataRevision: z.number().int().positive(),
	generation: z.number().int().positive(),
	providerSubject: z.string().min(1).max(1024),
};
export const oauthDisconnectTargetSchema = z
	.object({ ...existingTargetFields, kind: z.literal('disconnect') })
	.strict();
export const oauthCeremonyTargetSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('enroll'),
			applicationId: oauthApplicationIdSchema,
			accountBinding: accountBindingSchema.optional(),
		})
		.strict(),
	z.object({ ...existingTargetFields, kind: z.literal('reauthorize') }).strict(),
	oauthDisconnectTargetSchema,
]);
export type OAuthCeremonyTarget = z.infer<typeof oauthCeremonyTargetSchema>;
export const oauthCeremonyInitiatorSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('agent'), agentId: agentIdSchema }).strict(),
	z
		.object({ kind: z.literal('website_owner'), ownerIdentity: oauthBrowserOwnerIdentitySchema })
		.strict(),
]);
export type OAuthCeremonyInitiator = z.infer<typeof oauthCeremonyInitiatorSchema>;

export const oauthCeremonyCommonSchema = z
	.object({
		agentId: agentIdSchema,
		applicationIds: applicationsSchema.refine((applications) => applications.length > 0),
		browserBindingSecret: oauthOpaqueBrowserSecretSchema,
		configRevision: z.string().min(1).max(256),
		createdAtMs: z.number().int().nonnegative(),
		csrfSecret: oauthOpaqueBrowserSecretSchema,
		expiresAtMs: z.number().int().positive(),
		initiator: oauthCeremonyInitiatorSchema,
		publicCeremonyId: oauthTransactionIdSchema,
		suggestedAlias: z.string().min(1).max(320).optional(),
		suggestedSelections: oauthPermissionSelectionsSchema.optional(),
		target: oauthCeremonyTargetSchema,
		transactionId: oauthTransactionIdSchema,
	})
	.strict();
export const oauthSelectingTransactionSchema = oauthCeremonyCommonSchema
	.extend({
		identity: oauthBrowserSessionIdentitySchema.optional(),
		kind: z.literal('selecting-permissions'),
	})
	.strict();
export const oauthAuthorizingTransactionSchema = oauthCeremonyCommonSchema
	.extend({
		applicationId: oauthApplicationIdSchema,
		completedApplications: applicationsSchema,
		confirmedScopes: z.array(oauthScopeSchema).min(1).max(128).readonly(),
		confirmedSelections: oauthPermissionSelectionsSchema,
		identity: oauthBrowserSessionIdentitySchema,
		kind: z.literal('authorizing-application'),
		oauthState: oauthOpaqueBrowserSecretSchema,
		pkceChallenge: oauthOpaqueBrowserSecretSchema,
		pkceVerifier: oauthOpaqueBrowserSecretSchema,
		redirectUri: z.url().refine((uri) => new URL(uri).protocol === 'https:'),
		remainingApplications: applicationsSchema,
	})
	.strict();
export const oauthConsumingTransactionSchema = oauthAuthorizingTransactionSchema
	.extend({ kind: z.literal('consuming-callback') })
	.strict();
export const oauthCommittingDisconnectSchema = oauthSelectingTransactionSchema
	.extend({
		identity: oauthBrowserSessionIdentitySchema,
		kind: z.literal('committing-disconnect'),
		target: oauthDisconnectTargetSchema,
	})
	.strict();
export const oauthCeremonyTransactionSchema = z.discriminatedUnion('kind', [
	oauthSelectingTransactionSchema,
	oauthAuthorizingTransactionSchema,
	oauthConsumingTransactionSchema,
	oauthCommittingDisconnectSchema,
]);
export type OAuthCeremonyTransaction = z.infer<typeof oauthCeremonyTransactionSchema>;

export const oauthCompletionCommonSchema = oauthCeremonyCommonSchema
	.extend({
		applicationId: oauthApplicationIdSchema,
		completedApplications: applicationsSchema,
		completionSessionId: oauthCompletionSessionIdSchema,
		confirmedScopes: z.array(oauthScopeSchema).min(1).max(128).readonly(),
		confirmedSelections: oauthPermissionSelectionsSchema,
		identity: oauthBrowserSessionIdentitySchema,
		remainingApplications: applicationsSchema,
	})
	.strict();
type OAuthCompletionCommon = z.infer<typeof oauthCompletionCommonSchema>;
export type OAuthCompletionSession<TProviderGrant> =
	| (OAuthCompletionCommon & {
			readonly kind: 'awaiting-account-confirmation';
			readonly providerGrant: TProviderGrant;
	  })
	| (OAuthCompletionCommon & {
			readonly kind: 'committing';
			readonly providerGrant: TProviderGrant;
	  });

export const oauthCeremonyContextSchema = oauthCeremonyCommonSchema.pick({
	agentId: true,
	configRevision: true,
	initiator: true,
	publicCeremonyId: true,
	target: true,
	transactionId: true,
});
export type OAuthCeremonyContext = z.infer<typeof oauthCeremonyContextSchema>;

export type OAuthCallbackConsumptionResult =
	| {
			readonly kind: 'accepted';
			readonly transaction: z.infer<typeof oauthConsumingTransactionSchema>;
	  }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'consumed-or-missing'
				| 'expired'
				| 'identity-mismatch'
				| 'invalid-state'
				| 'invalid-redirect'
				| 'browser-binding-mismatch'
				| 'wrong-state';
	  };
export type OAuthCompletionCommitResult<TProviderGrant> =
	| {
			readonly kind: 'accepted';
			readonly session: Extract<
				OAuthCompletionSession<TProviderGrant>,
				{ readonly kind: 'committing' }
			>;
	  }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'browser-binding-mismatch'
				| 'consumed-or-missing'
				| 'csrf-mismatch'
				| 'expired'
				| 'identity-mismatch'
				| 'wrong-state';
	  };
export type OAuthCallbackCompletionResult<TProviderGrant> =
	| {
			readonly kind: 'created';
			readonly session: Extract<
				OAuthCompletionSession<TProviderGrant>,
				{ readonly kind: 'awaiting-account-confirmation' }
			>;
	  }
	| { readonly kind: 'capacity-exhausted' };
