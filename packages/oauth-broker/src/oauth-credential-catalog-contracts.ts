import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthProviderIdSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { encryptedOAuthEnvelopeSchema, oauthProviderSubjectSchema } from './envelope-codec.js';

const oauthGrantLifecycleKindSchema = z.enum(['active', 'degraded', 'reauthorization-required']);

export const oauthStoredGrantSchema = z
	.object({
		accountLabel: z.string().min(1).max(320),
		accountProfileId: oauthAccountProfileIdSchema,
		accountProfileStatus: z.enum(['partially-enrolled', 'enrolled']),
		agentId: z.string().min(1).max(128),
		applicationId: oauthApplicationIdSchema,
		credentialId: oauthCredentialIdSchema,
		envelope: encryptedOAuthEnvelopeSchema,
		failureClass: z.string().min(1).max(128).nullable(),
		grantedScopes: z.array(oauthScopeSchema).readonly(),
		lastRefreshAttemptAtMs: z.number().int().nonnegative().nullable(),
		lastRefreshSucceededAtMs: z.number().int().nonnegative().nullable(),
		lifecycleKind: oauthGrantLifecycleKindSchema,
		materialRevision: oauthMaterialRevisionSchema,
		nextRefreshEligibleAtMs: z.number().int().nonnegative().nullable(),
		profileRecordId: z.uuid(),
		providerCredentialVersion: z.number().int().positive(),
		providerId: oauthProviderIdSchema,
		providerSubject: oauthProviderSubjectSchema,
		reauthorizationReason: z.string().min(1).max(128).nullable(),
		recordRevision: z.number().int().positive(),
		updatedAtMs: z.number().int().nonnegative(),
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthStoredGrant = z.infer<typeof oauthStoredGrantSchema>;

export const oauthStoredAccountProfileMetadataSchema = z
	.object({
		accountLabel: z.string().min(1).max(320),
		accountProfileId: oauthAccountProfileIdSchema,
		agentId: z.string().min(1).max(128),
		providerSubject: oauthProviderSubjectSchema,
		status: z.enum(['partially-enrolled', 'enrolled']),
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthStoredAccountProfileMetadata = z.infer<
	typeof oauthStoredAccountProfileMetadataSchema
>;

export const oauthEnrollmentGrantInputSchema = z
	.object({
		accountLabel: z.string().min(1).max(320),
		accountProfileId: oauthAccountProfileIdSchema,
		accountProfileStatus: z.enum(['partially-enrolled', 'enrolled']),
		agentId: z.string().min(1).max(128),
		applicationId: oauthApplicationIdSchema,
		credentialId: oauthCredentialIdSchema,
		envelope: encryptedOAuthEnvelopeSchema,
		grantedScopes: z.array(oauthScopeSchema).min(1).readonly(),
		materialRevision: oauthMaterialRevisionSchema,
		providerCredentialVersion: z.number().int().positive(),
		providerId: oauthProviderIdSchema,
		providerSubject: oauthProviderSubjectSchema,
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthEnrollmentGrantInput = z.infer<typeof oauthEnrollmentGrantInputSchema>;

export const oauthReplaceGrantEnvelopeInputSchema = z
	.object({
		credentialId: oauthCredentialIdSchema,
		envelope: encryptedOAuthEnvelopeSchema,
		expectedRecordRevision: z.number().int().positive(),
		failureClass: z.string().min(1).max(128).nullable(),
		lastRefreshAttemptAtMs: z.number().int().nonnegative(),
		lastRefreshSucceededAtMs: z.number().int().nonnegative().nullable(),
		lifecycleKind: oauthGrantLifecycleKindSchema,
		materialRevision: oauthMaterialRevisionSchema,
		nextRefreshEligibleAtMs: z.number().int().nonnegative().nullable(),
		providerCredentialVersion: z.number().int().positive(),
		reauthorizationReason: z.string().min(1).max(128).nullable(),
	})
	.strict();
export type OAuthReplaceGrantEnvelopeInput = z.infer<typeof oauthReplaceGrantEnvelopeInputSchema>;

export type OAuthCommitEnrollmentResult =
	| { readonly grant: OAuthStoredGrant; readonly kind: 'committed' }
	| {
			readonly actualProviderSubject: string;
			readonly expectedProviderSubject: string;
			readonly kind: 'subject-mismatch';
	  };

export type OAuthReplaceGrantEnvelopeResult =
	| { readonly grant: OAuthStoredGrant; readonly kind: 'updated' }
	| { readonly kind: 'missing' }
	| { readonly currentRecordRevision: number; readonly kind: 'stale' };

export type OAuthDeleteGrantResult =
	| { readonly kind: 'deleted' }
	| { readonly kind: 'missing' }
	| {
			readonly currentCredentialId: z.infer<typeof oauthCredentialIdSchema>;
			readonly currentRecordRevision: number;
			readonly kind: 'stale';
	  };

export interface OAuthCredentialCatalog {
	close(): void;
	commitEnrollmentGrant(input: OAuthEnrollmentGrantInput): OAuthCommitEnrollmentResult;
	deleteGrantForAccountApplication(props: {
		readonly accountProfileId: z.infer<typeof oauthAccountProfileIdSchema>;
		readonly agentId: string;
		readonly applicationId: z.infer<typeof oauthApplicationIdSchema>;
		readonly expectedCredentialId: z.infer<typeof oauthCredentialIdSchema>;
		readonly expectedRecordRevision: number;
		readonly zoneId: string;
	}): OAuthDeleteGrantResult;
	getGrant(credentialId: z.infer<typeof oauthCredentialIdSchema>): OAuthStoredGrant | undefined;
	getAccountProfileMetadata(props: {
		readonly accountProfileId: z.infer<typeof oauthAccountProfileIdSchema>;
		readonly agentId: string;
		readonly zoneId: string;
	}): OAuthStoredAccountProfileMetadata | undefined;
	getGrantForAccountApplication(props: {
		readonly accountProfileId: z.infer<typeof oauthAccountProfileIdSchema>;
		readonly agentId: string;
		readonly applicationId: z.infer<typeof oauthApplicationIdSchema>;
		readonly zoneId: string;
	}): OAuthStoredGrant | undefined;
	getStorageDiagnostics(): {
		readonly busyTimeoutMs: number;
		readonly foreignKeysEnabled: boolean;
		readonly journalMode: string;
		readonly synchronousMode: number;
	};
	listGrantsForAgent(props: {
		readonly agentId: string;
		readonly zoneId: string;
	}): readonly OAuthStoredGrant[];
	replaceGrantEnvelope(props: OAuthReplaceGrantEnvelopeInput): OAuthReplaceGrantEnvelopeResult;
	verifyOrInitializeKeyEncryptionKey(keyEncryptionKey: Uint8Array): void;
}
