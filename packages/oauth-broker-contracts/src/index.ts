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

export const oauthPermissionChoiceSchema = z.enum(['none', 'read', 'write']);
export type OAuthPermissionChoice = z.infer<typeof oauthPermissionChoiceSchema>;

export const oauthMinimumPermissionSchema = z.enum(['read', 'write']);
export type OAuthMinimumPermission = z.infer<typeof oauthMinimumPermissionSchema>;

export const oauthPermissionSelectionsSchema = z
	.record(oauthApplicationIdSchema, z.record(oauthServiceIdSchema, oauthPermissionChoiceSchema))
	.readonly();
export type OAuthPermissionSelections = z.infer<typeof oauthPermissionSelectionsSchema>;

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

export const oauthToolRequirementSchema = z.discriminatedUnion('kind', [
	z
		.object({
			applicationId: oauthApplicationIdSchema,
			kind: z.literal('oauth-account-profile'),
			minimumPermission: oauthMinimumPermissionSchema,
			serviceId: oauthServiceIdSchema,
		})
		.strict(),
	z
		.object({
			accountProfileArgument: z.literal('accountProfile'),
			describeBeforeCall: z.literal(true),
			kind: z.literal('invocation-dependent-oauth-account-profile'),
		})
		.strict(),
]);
export type OAuthToolRequirement = z.infer<typeof oauthToolRequirementSchema>;

export const oauthEligibleAccountProfileSchema = z
	.object({
		accountLabel: z.string().min(1).max(320),
		accountProfileId: oauthAccountProfileIdSchema,
	})
	.strict();
export type OAuthEligibleAccountProfile = z.infer<typeof oauthEligibleAccountProfileSchema>;

export const oauthToolAvailabilitySchema = z.discriminatedUnion('kind', [
	z
		.object({
			accountProfiles: z.array(oauthEligibleAccountProfileSchema).readonly(),
			kind: z.literal('ready'),
		})
		.strict(),
	z.object({ kind: z.literal('authorization-required') }).strict(),
	z.object({ kind: z.literal('reauthorization-required') }).strict(),
	z.object({ kind: z.literal('scope-insufficient') }).strict(),
	z.object({ kind: z.literal('authorization-status-unavailable') }).strict(),
]);
export type OAuthToolAvailability = z.infer<typeof oauthToolAvailabilitySchema>;

export const oauthApplicationGrantStatusSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		grantedScopes: z.array(oauthScopeSchema).readonly(),
		lifecycle: oauthCredentialLifecycleStateSchema,
	})
	.strict();
export type OAuthApplicationGrantStatus = z.infer<typeof oauthApplicationGrantStatusSchema>;

export const oauthAccountProfileStatusSchema = z
	.object({
		accountLabel: z.string().min(1).max(320).optional(),
		accountProfileId: oauthAccountProfileIdSchema,
		applications: z.array(oauthApplicationGrantStatusSchema).readonly(),
		kind: z.enum(['unbound', 'partially-enrolled', 'enrolled']),
	})
	.strict();
export type OAuthAccountProfileStatus = z.infer<typeof oauthAccountProfileStatusSchema>;

export const oauthPublicFailureSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('authorization-denied') }).strict(),
	z.object({ kind: z.literal('cancelled') }).strict(),
	z.object({ kind: z.literal('consumed') }).strict(),
	z.object({ kind: z.literal('expired') }).strict(),
	z.object({ kind: z.literal('identity-mismatch') }).strict(),
	z.object({ kind: z.literal('provider-unavailable'), retryable: z.boolean() }).strict(),
	z.object({ kind: z.literal('scope-insufficient') }).strict(),
	z.object({ kind: z.literal('subject-mismatch') }).strict(),
	z.object({ kind: z.literal('unavailable') }).strict(),
]);
export type OAuthPublicFailure = z.infer<typeof oauthPublicFailureSchema>;

export const oauthAuthorizationActionIdSchema = z.enum([
	'oauth_authorization.list',
	'oauth_authorization.begin',
	'oauth_authorization.status',
	'oauth_authorization.cancel',
	'oauth_authorization.reauthorize',
	'oauth_authorization.revoke',
]);
export type OAuthAuthorizationActionId = z.infer<typeof oauthAuthorizationActionIdSchema>;

export const oauthAuthorizationActionRequestSchema = z.discriminatedUnion('actionId', [
	z.object({ actionId: z.literal('oauth_authorization.list') }).strict(),
	z
		.object({
			actionId: z.literal('oauth_authorization.begin'),
			accountProfileId: oauthAccountProfileIdSchema,
			suggestedSelections: oauthPermissionSelectionsSchema.optional(),
		})
		.strict(),
	z
		.object({
			actionId: z.literal('oauth_authorization.status'),
			transactionId: oauthTransactionIdSchema,
		})
		.strict(),
	z
		.object({
			actionId: z.literal('oauth_authorization.cancel'),
			transactionId: oauthTransactionIdSchema,
		})
		.strict(),
	z
		.object({
			actionId: z.literal('oauth_authorization.reauthorize'),
			accountProfileId: oauthAccountProfileIdSchema,
			applicationId: oauthApplicationIdSchema,
			suggestedSelections: oauthPermissionSelectionsSchema.optional(),
		})
		.strict(),
	z
		.object({
			actionId: z.literal('oauth_authorization.revoke'),
			accountProfileId: oauthAccountProfileIdSchema,
			applicationId: oauthApplicationIdSchema,
		})
		.strict(),
]);
export type OAuthAuthorizationActionRequest = z.infer<typeof oauthAuthorizationActionRequestSchema>;

export const oauthAuthorizationActionResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('authorization-list'),
			profiles: z.array(oauthAccountProfileStatusSchema).readonly(),
		})
		.strict(),
	z
		.object({
			authorizationUrl: z.url(),
			expiresAt: z.iso.datetime(),
			kind: z.literal('authorization-begun'),
			transactionId: oauthTransactionIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('authorization-pending'),
			transactionId: oauthTransactionIdSchema,
		})
		.strict(),
	z
		.object({
			accountLabel: z.string().min(1).max(320),
			accountProfileId: oauthAccountProfileIdSchema,
			applicationId: oauthApplicationIdSchema,
			grantedScopes: z.array(oauthScopeSchema).readonly(),
			kind: z.literal('authorization-completed'),
		})
		.strict(),
	z
		.object({
			failure: oauthPublicFailureSchema,
			kind: z.literal('authorization-failed'),
		})
		.strict(),
	z.object({ kind: z.literal('authorization-cancelled') }).strict(),
	z.object({ kind: z.literal('authorization-revoked') }).strict(),
]);
export type OAuthAuthorizationActionResult = z.infer<typeof oauthAuthorizationActionResultSchema>;
