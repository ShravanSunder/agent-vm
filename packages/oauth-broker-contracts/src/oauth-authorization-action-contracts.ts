import { z } from 'zod';

import {
	googleOperationEffectSchema,
	oauthAccountIdSchema,
} from './google-account-policy-contracts.js';
import {
	oauthApplicationIdSchema,
	oauthScopeSchema,
	oauthServiceIdSchema,
	oauthTransactionIdSchema,
} from './oauth-identifiers.js';
import { oauthPermissionSelectionsSchema } from './oauth-permission-contracts.js';
import { oauthCredentialLifecycleStateSchema } from './oauth-token-lifecycle-contracts.js';

const publicLabelSchema = z.string().min(1).max(320);
export const oauthAuthorizationServiceOptionSchema = z
	.object({
		serviceId: oauthServiceIdSchema,
		serviceLabel: publicLabelSchema,
		groups: z
			.array(
				z
					.object({
						groupId: z.string().min(1).max(128),
						label: publicLabelSchema,
						effect: googleOperationEffectSchema,
						scopeDescriptions: z.array(z.string().min(1).max(1024)).readonly(),
					})
					.strict(),
			)
			.min(1)
			.readonly(),
	})
	.strict();
export type OAuthAuthorizationServiceOption = z.infer<typeof oauthAuthorizationServiceOptionSchema>;

export const oauthAuthorizationApplicationOptionSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		applicationLabel: publicLabelSchema,
		services: z.array(oauthAuthorizationServiceOptionSchema).min(1).readonly(),
	})
	.strict();
export type OAuthAuthorizationApplicationOption = z.infer<
	typeof oauthAuthorizationApplicationOptionSchema
>;

export const oauthAccountActivityAvailabilitySchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('ready'),
			disposition: z.enum(['ask', 'allow']),
			overrideRevision: z.number().int().positive(),
			defaultsRevision: z.string().min(1).max(256),
		})
		.strict(),
	z.object({ kind: z.literal('consent-required') }).strict(),
	z.object({ kind: z.literal('denied') }).strict(),
	z.object({ kind: z.literal('unavailable') }).strict(),
]);
export type OAuthAccountActivityAvailability = z.infer<
	typeof oauthAccountActivityAvailabilitySchema
>;

export const oauthApplicationGrantStatusSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		applicationLabel: publicLabelSchema,
		accessState: z.enum(['connected', 'replacing', 'disconnecting', 'disconnected']),
		lifecycle: oauthCredentialLifecycleStateSchema,
		// No usable permission description can be constructed from unauthenticated row hints.
		metadata: z.discriminatedUnion('kind', [
			z
				.object({
					kind: z.literal('verified'),
					accountAlias: publicLabelSchema,
					confirmedGroupIds: z.array(z.string().min(1).max(128)).max(64).readonly(),
					grantedScopes: z.array(oauthScopeSchema).max(128).readonly(),
					scopeDescriptions: z.array(z.string().min(1).max(1024)).readonly(),
				})
				.strict(),
			z.object({ kind: z.literal('unavailable') }).strict(),
		]),
		activities: z
			.array(
				z
					.object({
						operationId: z.string().min(1).max(128),
						availability: oauthAccountActivityAvailabilitySchema,
					})
					.strict(),
			)
			.readonly(),
	})
	.strict()
	.refine(
		(status) =>
			!status.activities.some((activity) => activity.availability.kind === 'ready') ||
			(status.accessState === 'connected' &&
				status.lifecycle.kind === 'active' &&
				status.metadata.kind === 'verified'),
		{ message: 'Ready activity requires a connected, active, authenticated authorization.' },
	);
export type OAuthApplicationGrantStatus = z.infer<typeof oauthApplicationGrantStatusSchema>;

export const oauthAccountStatusSchema = z
	.object({
		accountId: oauthAccountIdSchema,
		applications: z.array(oauthApplicationGrantStatusSchema).min(1).readonly(),
	})
	.strict();
export type OAuthAccountStatus = z.infer<typeof oauthAccountStatusSchema>;

export const oauthPublicFailureSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.enum([
				'authorization-denied',
				'cancelled',
				'consumed',
				'expired',
				'identity-mismatch',
				'scope-insufficient',
				'scope-mismatch',
				'subject-mismatch',
				'unavailable',
				'configuration-change-required',
				'duplicate-authorization',
				'stale-authorization',
			]),
		})
		.strict(),
	z.object({ kind: z.literal('provider-unavailable'), retryable: z.boolean() }).strict(),
]);
export type OAuthPublicFailure = z.infer<typeof oauthPublicFailureSchema>;

export const oauthAuthorizationActionIdSchema = z.enum([
	'oauth_authorization.list',
	'oauth_authorization.begin',
	'oauth_authorization.status',
	'oauth_authorization.cancel',
	'oauth_authorization.reauthorize',
	'oauth_authorization.disconnect',
]);
export type OAuthAuthorizationActionId = z.infer<typeof oauthAuthorizationActionIdSchema>;

export const oauthAuthorizationListRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.list'),
	})
	.strict();
export const oauthAuthorizationBeginRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.begin'),
		applicationId: oauthApplicationIdSchema,
		suggestedAlias: publicLabelSchema.optional(),
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
		accountId: oauthAccountIdSchema,
		applicationId: oauthApplicationIdSchema,
		suggestedSelections: oauthPermissionSelectionsSchema.optional(),
	})
	.strict();
export const oauthAuthorizationDisconnectRequestSchema = z
	.object({
		actionId: z.literal('oauth_authorization.disconnect'),
		accountId: oauthAccountIdSchema,
		applicationId: oauthApplicationIdSchema,
	})
	.strict();

export const oauthAuthorizationActionRequestSchema = z.discriminatedUnion('actionId', [
	oauthAuthorizationListRequestSchema,
	oauthAuthorizationBeginRequestSchema,
	oauthAuthorizationStatusRequestSchema,
	oauthAuthorizationCancelRequestSchema,
	oauthAuthorizationReauthorizeRequestSchema,
	oauthAuthorizationDisconnectRequestSchema,
]);
export type OAuthAuthorizationActionRequest = z.infer<typeof oauthAuthorizationActionRequestSchema>;

export const oauthAuthorizationActionResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('authorization-list'),
			accounts: z.array(oauthAccountStatusSchema).readonly(),
			authorizationOptions: z.array(oauthAuthorizationApplicationOptionSchema).readonly(),
		})
		.strict(),
	z
		.object({
			authorizationUrl: z.url().refine((url) => new URL(url).protocol === 'https:'),
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
			accountAlias: publicLabelSchema,
			accountId: oauthAccountIdSchema,
			applicationId: oauthApplicationIdSchema,
			grantedScopes: z.array(oauthScopeSchema).readonly(),
			kind: z.literal('authorization-completed'),
		})
		.strict(),
	z.object({ failure: oauthPublicFailureSchema, kind: z.literal('authorization-failed') }).strict(),
	z.object({ kind: z.literal('authorization-cancelled') }).strict(),
	z
		.object({
			kind: z.enum([
				'authorization-disconnected',
				'authorization-disconnecting',
				'authorization-replacement-pending',
				'authorization-containment-failed',
			]),
			accountId: oauthAccountIdSchema,
			applicationId: oauthApplicationIdSchema,
		})
		.strict(),
]);
export type OAuthAuthorizationActionResult = z.infer<typeof oauthAuthorizationActionResultSchema>;
