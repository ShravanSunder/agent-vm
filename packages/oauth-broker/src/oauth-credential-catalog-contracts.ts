import {
	oauthAccountIdSchema,
	type oauthApplicationIdSchema,
	oauthAuthorizationIdSchema,
	oauthBrowserOwnerIdentitySchema,
	type oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthProviderIdSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import {
	encryptedOAuthEnvelopeSchema,
	oauthEnvelopeBindingSchema,
	oauthProviderSubjectSchema,
} from './envelope-codec.js';
import {
	oauthAccountPolicyChangeEventSchema,
	type OAuthAccountPolicySaveInput,
	type OAuthAccountPolicyActivationInput,
	type OAuthAccountPolicyContainmentInput,
	type OAuthAccountPolicyChangeEvent,
} from './oauth-account-policy-contracts.js';
import {
	oauthPolicyDefaultsChangeEventSchema,
	type OAuthPolicyDefaultsActivationInput,
	type OAuthStoredPolicyDefaultsActivation,
	type OAuthPolicyDefaultsChangeEvent,
} from './oauth-policy-defaults-contracts.js';

const timestampSchema = z.number().int().nonnegative();
const revisionSchema = z.number().int().positive();
const groupIdsSchema = z.array(z.string().min(1).max(128)).max(64).readonly();
const scopeSetSchema = z.array(oauthScopeSchema).max(128).readonly();
const lifecycleKindSchema = z.enum(['active', 'degraded', 'reauthorization-required']);

export const oauthStoredAccountMetadataSchema = z
	.object({
		accountId: oauthAccountIdSchema,
		accountLabel: z.string().min(1).max(320),
		createdAtMs: timestampSchema,
		owner: oauthBrowserOwnerIdentitySchema,
		providerId: oauthProviderIdSchema,
		providerSubject: oauthProviderSubjectSchema,
		recordRevision: revisionSchema,
		updatedAtMs: timestampSchema,
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthStoredAccountMetadata = z.infer<typeof oauthStoredAccountMetadataSchema>;

export const oauthStoredGrantSchema = oauthEnvelopeBindingSchema
	.extend({
		accountAlias: z.string().min(1).max(320),
		envelope: encryptedOAuthEnvelopeSchema,
		failureClass: z.string().min(1).max(128).nullable(),
		grantedScopes: scopeSetSchema,
		lastRefreshAttemptAtMs: timestampSchema.nullable(),
		lastRefreshSucceededAtMs: timestampSchema.nullable(),
		lifecycleKind: lifecycleKindSchema,
		materialRevision: oauthMaterialRevisionSchema,
		nextRefreshEligibleAtMs: timestampSchema.nullable(),
		providerCredentialVersion: revisionSchema,
		reauthorizationReason: z.string().min(1).max(128).nullable(),
		recordRevision: revisionSchema,
		requestedScopes: scopeSetSchema,
		selectedGroupIds: groupIdsSchema,
		transitionId: z.uuid(),
		updatedAtMs: timestampSchema,
	})
	.strict();
export type OAuthStoredGrant = z.infer<typeof oauthStoredGrantSchema>;

const authorizationMetadataSchema = oauthStoredGrantSchema.omit({
	credentialId: true,
	envelope: true,
	materialRevision: true,
});
export const oauthStoredAuthorizationSchema = z.discriminatedUnion('accessState', [
	oauthStoredGrantSchema.extend({ accessState: z.enum(['connected', 'replacing']) }).strict(),
	authorizationMetadataSchema
		.extend({
			accessState: z.enum(['disconnecting', 'disconnected']),
			credentialId: z.null(),
			envelope: z.null(),
			materialRevision: z.null(),
		})
		.strict(),
]);
export type OAuthStoredAuthorization = z.infer<typeof oauthStoredAuthorizationSchema>;

export const oauthEnrollmentGrantInputSchema = oauthStoredGrantSchema
	.omit({
		failureClass: true,
		lastRefreshAttemptAtMs: true,
		lastRefreshSucceededAtMs: true,
		lifecycleKind: true,
		nextRefreshEligibleAtMs: true,
		reauthorizationReason: true,
		recordRevision: true,
		transitionId: true,
		updatedAtMs: true,
	})
	.extend({
		accountLabel: z.string().min(1).max(320),
		expectedRecordRevision: revisionSchema.nullable(),
		initialPolicyEnvelope: encryptedOAuthEnvelopeSchema.optional(),
		providerCredentialVersion: revisionSchema.default(1),
	})
	.strict();
export type OAuthEnrollmentGrantInput = z.infer<typeof oauthEnrollmentGrantInputSchema>;

export const oauthReplaceGrantEnvelopeInputSchema = oauthStoredGrantSchema
	.pick({
		credentialId: true,
		envelope: true,
		failureClass: true,
		lastRefreshAttemptAtMs: true,
		lastRefreshSucceededAtMs: true,
		lifecycleKind: true,
		materialRevision: true,
		nextRefreshEligibleAtMs: true,
		providerCredentialVersion: true,
		reauthorizationReason: true,
	})
	.extend({ expectedRecordRevision: revisionSchema })
	.strict();
export type OAuthReplaceGrantEnvelopeInput = z.infer<typeof oauthReplaceGrantEnvelopeInputSchema>;

export const oauthStoredPolicySchema = z
	.object({
		authorizationId: oauthAuthorizationIdSchema,
		envelope: encryptedOAuthEnvelopeSchema,
		overrideRevision: revisionSchema,
		state: z.enum(['active', 'applying']),
		transitionId: z.uuid(),
		updatedAtMs: timestampSchema,
	})
	.strict();
export type OAuthStoredPolicy = z.infer<typeof oauthStoredPolicySchema>;

export const oauthAuthorizationChangeEventSchema = z
	.object({
		accountId: oauthAccountIdSchema,
		agentId: z.string().min(1).max(128),
		actor: z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('owner'), identity: oauthBrowserOwnerIdentitySchema }).strict(),
			z.object({ kind: z.literal('system-initialization') }).strict(),
			z.object({ kind: z.literal('system-recovery') }).strict(),
		]),
		authorizationId: oauthAuthorizationIdSchema,
		eventId: z.uuid(),
		kind: z.enum([
			'authorization-created',
			'authorization-replaced',
			'authorization-disconnecting',
			'authorization-settled',
			'policy-initialized',
		]),
		newRevision: revisionSchema,
		oldRevision: revisionSchema.nullable(),
		selectedGroupIds: groupIdsSchema,
		timestampMs: timestampSchema,
		transitionId: z.uuid(),
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthAuthorizationChangeEvent = z.infer<typeof oauthAuthorizationChangeEventSchema>;
export const oauthPermissionChangeEventSchema = z.union([
	oauthAuthorizationChangeEventSchema,
	oauthPolicyDefaultsChangeEventSchema,
	oauthAccountPolicyChangeEventSchema,
]);
export type OAuthPermissionChangeEvent = z.infer<typeof oauthPermissionChangeEventSchema>;
export type OAuthAccountPolicyMutationResult =
	| { readonly kind: 'updated'; readonly policy: OAuthStoredPolicy }
	| { readonly kind: 'unavailable' | 'stale' | 'owner-mismatch' | 'defaults-changed' };

export type OAuthCommitEnrollmentResult =
	| { readonly authorization: OAuthStoredAuthorization; readonly kind: 'committed' }
	| { readonly kind: 'owner-mismatch' | 'account-conflict' | 'duplicate-authorization' | 'stale' };
export type OAuthReplaceGrantEnvelopeResult =
	| { readonly grant: OAuthStoredGrant; readonly kind: 'updated' }
	| { readonly kind: 'missing' }
	| { readonly currentRecordRevision: number; readonly kind: 'stale' };
export type OAuthAuthorizationTransitionResult =
	| { readonly authorization: OAuthStoredAuthorization; readonly kind: 'updated' }
	| { readonly kind: 'missing' | 'stale' | 'owner-mismatch' };

export interface OAuthAccountApplicationQuery {
	readonly accountId: z.infer<typeof oauthAccountIdSchema>;
	readonly agentId: string;
	readonly applicationId: z.infer<typeof oauthApplicationIdSchema>;
	readonly zoneId: string;
}

export interface OAuthCredentialCatalog {
	close(): void;
	commitEnrollmentGrant(input: OAuthEnrollmentGrantInput): OAuthCommitEnrollmentResult;
	replaceAuthorization(input: OAuthEnrollmentGrantInput): OAuthCommitEnrollmentResult;
	getAccountMetadata(
		accountId: z.infer<typeof oauthAccountIdSchema>,
	): OAuthStoredAccountMetadata | undefined;
	findAccount(props: {
		readonly zoneId: string;
		readonly providerId: string;
		readonly providerSubject: string;
	}): OAuthStoredAccountMetadata | undefined;
	getAuthorization(
		authorizationId: z.infer<typeof oauthAuthorizationIdSchema>,
	): OAuthStoredAuthorization | undefined;
	getAuthorizationForAccountApplication(
		props: OAuthAccountApplicationQuery,
	): OAuthStoredAuthorization | undefined;
	getGrant(credentialId: z.infer<typeof oauthCredentialIdSchema>): OAuthStoredGrant | undefined;
	getGrantForAccountApplication(props: OAuthAccountApplicationQuery): OAuthStoredGrant | undefined;
	listGrantsForAgent(props: {
		readonly agentId: string;
		readonly zoneId: string;
	}): readonly OAuthStoredGrant[];
	listAuthorizationsForAgent(props: {
		readonly agentId: string;
		readonly zoneId: string;
	}): readonly OAuthStoredAuthorization[];
	getPolicy(
		authorizationId: z.infer<typeof oauthAuthorizationIdSchema>,
	): OAuthStoredPolicy | undefined;
	saveAccountPolicy(input: OAuthAccountPolicySaveInput): OAuthAccountPolicyMutationResult;
	activateAccountPolicy(input: OAuthAccountPolicyActivationInput): OAuthAccountPolicyMutationResult;
	recordAccountPolicyContainment(
		input: OAuthAccountPolicyContainmentInput,
	): OAuthAccountPolicyMutationResult;
	listAccountPolicyHistory(
		authorizationId: z.infer<typeof oauthAuthorizationIdSchema>,
	): readonly OAuthAccountPolicyChangeEvent[];
	listAuthorizationHistory(
		authorizationId: z.infer<typeof oauthAuthorizationIdSchema>,
	): readonly OAuthAuthorizationChangeEvent[];
	activatePolicyDefaults(input: OAuthPolicyDefaultsActivationInput): {
		readonly kind: 'activated' | 'unchanged';
		readonly activation: OAuthStoredPolicyDefaultsActivation;
	};
	getPolicyDefaultsActivation(zoneId: string): OAuthStoredPolicyDefaultsActivation | undefined;
	listPolicyDefaultsHistory(zoneId: string): readonly OAuthPolicyDefaultsChangeEvent[];
	replaceGrantEnvelope(input: OAuthReplaceGrantEnvelopeInput): OAuthReplaceGrantEnvelopeResult;
	disconnectAuthorization(props: {
		readonly authorizationId: z.infer<typeof oauthAuthorizationIdSchema>;
		readonly expectedRecordRevision: number;
		readonly owner: z.infer<typeof oauthBrowserOwnerIdentitySchema>;
	}): OAuthAuthorizationTransitionResult;
	settleAuthorizationTransition(props: {
		readonly authorizationId: z.infer<typeof oauthAuthorizationIdSchema>;
		readonly expectedRecordRevision: number;
		readonly transitionId: string;
	}): OAuthAuthorizationTransitionResult;
	getStorageDiagnostics(): {
		readonly busyTimeoutMs: number;
		readonly foreignKeysEnabled: boolean;
		readonly journalMode: string;
		readonly synchronousMode: number;
	};
	verifyOrInitializeKeyEncryptionKey(keyEncryptionKey: Uint8Array): void;
}
