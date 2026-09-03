import { z } from 'zod';

import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthScopeSchema,
	oauthServiceIdSchema,
	oauthTransactionIdSchema,
} from './oauth-identifiers.js';
import {
	oauthMinimumPermissionSchema,
	oauthPermissionSelectionsSchema,
} from './oauth-permission-contracts.js';
import { oauthCredentialLifecycleStateSchema } from './oauth-token-lifecycle-contracts.js';

export const oauthApplicationGrantStatusSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		grantedScopes: z.array(oauthScopeSchema).readonly(),
		lifecycle: oauthCredentialLifecycleStateSchema,
	})
	.strict();
export type OAuthApplicationGrantStatus = z.infer<typeof oauthApplicationGrantStatusSchema>;

export const oauthAuthorizationServiceOptionSchema = z
	.object({
		maximumPermission: oauthMinimumPermissionSchema,
		serviceId: oauthServiceIdSchema,
		serviceLabel: z.string().min(1).max(320),
	})
	.strict();
export type OAuthAuthorizationServiceOption = z.infer<typeof oauthAuthorizationServiceOptionSchema>;

export const oauthAuthorizationApplicationOptionSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		applicationLabel: z.string().min(1).max(320),
		services: z.array(oauthAuthorizationServiceOptionSchema).min(1).readonly(),
	})
	.strict();
export type OAuthAuthorizationApplicationOption = z.infer<
	typeof oauthAuthorizationApplicationOptionSchema
>;

export const oauthAccountProfileStatusSchema = z
	.object({
		accountLabel: z.string().min(1).max(320).optional(),
		accountProfileId: oauthAccountProfileIdSchema,
		applications: z.array(oauthApplicationGrantStatusSchema).readonly(),
		authorizationOptions: z.array(oauthAuthorizationApplicationOptionSchema).min(1).readonly(),
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

export const oauthAuthorizationListRequestSchema = z
	.object({ actionId: z.literal('oauth_authorization.list') })
	.strict();
export const oauthAuthorizationBeginRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.begin'),
		accountProfileId: oauthAccountProfileIdSchema,
		suggestedSelections: oauthPermissionSelectionsSchema.optional(),
	})
	.strict();
export const oauthAuthorizationStatusRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.status'),
		transactionId: oauthTransactionIdSchema,
	})
	.strict();
export const oauthAuthorizationCancelRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.cancel'),
		transactionId: oauthTransactionIdSchema,
	})
	.strict();
export const oauthAuthorizationReauthorizeRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.reauthorize'),
		accountProfileId: oauthAccountProfileIdSchema,
		applicationId: oauthApplicationIdSchema,
		suggestedSelections: oauthPermissionSelectionsSchema.optional(),
	})
	.strict();
export const oauthAuthorizationRevokeRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.revoke'),
		accountProfileId: oauthAccountProfileIdSchema,
		applicationId: oauthApplicationIdSchema,
	})
	.strict();

export const oauthAuthorizationActionRequestSchema = z.discriminatedUnion('actionId', [
	oauthAuthorizationListRequestSchema,
	oauthAuthorizationBeginRequestSchema,
	oauthAuthorizationStatusRequestSchema,
	oauthAuthorizationCancelRequestSchema,
	oauthAuthorizationReauthorizeRequestSchema,
	oauthAuthorizationRevokeRequestSchema,
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
		.object({ kind: z.literal('authorization-pending'), transactionId: oauthTransactionIdSchema })
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
	z.object({ failure: oauthPublicFailureSchema, kind: z.literal('authorization-failed') }).strict(),
	z.object({ kind: z.literal('authorization-cancelled') }).strict(),
	z.object({ kind: z.literal('authorization-revoked') }).strict(),
]);
export type OAuthAuthorizationActionResult = z.infer<typeof oauthAuthorizationActionResultSchema>;
