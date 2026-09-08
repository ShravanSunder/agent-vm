import {
	oauthApplicationIdSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthProviderIdSchema,
	oauthScopeSchema,
	oauthTokenLifecycleSchema,
} from '@agent-vm/oauth-broker-contracts';
import { vi } from 'vitest';

import { createOAuthEnvelopeCodec, oauthEnvelopeBindingSchema } from '../envelope-codec.js';
import {
	oauthStoredGrantSchema,
	type OAuthCredentialCatalog,
	type OAuthReplaceGrantEnvelopeInput,
	type OAuthStoredGrant,
} from '../oauth-credential-catalog-contracts.js';
import { googleStoredCredentialPayloadSchema } from './google-credential-payload.js';
import {
	googleWebClientCredentialsSchema,
	type GoogleOAuthAdapter,
	type GoogleRefreshResult,
} from './google-oauth-adapter.js';

export const keyEncryptionKey = new Uint8Array(32).fill(63);
const credentialId = oauthCredentialIdSchema.parse('11111111-1111-4111-8111-111111111111');
const applicationId = oauthApplicationIdSchema.parse('gmail-app');
const providerId = oauthProviderIdSchema.parse('google');
export const gmailReadScope = oauthScopeSchema.parse('gmail.readonly');
export const gmailWriteScope = oauthScopeSchema.parse('gmail.modify');
export const envelopeCodec = createOAuthEnvelopeCodec({
	payloadSchema: googleStoredCredentialPayloadSchema,
});
export const binding = oauthEnvelopeBindingSchema.parse({
	accountId: '22222222-2222-4222-8222-222222222222',
	agentId: 'sun',
	applicationId,
	authorizationId: '33333333-3333-4333-8333-333333333333',
	authorizationMetadataRevision: 1,
	catalogVersion: 'google-v1',
	clientBindingRevision: 'client-binding-1',
	clientId: 'client-id',
	credentialId,
	generation: 1,
	owner: { issuer: 'https://identity.example.test', userId: 'test-owner' },
	providerId,
	providerSubject: 'google-subject-1',
	zoneId: 'test-zone',
});
export const clientCredentials = googleWebClientCredentialsSchema.parse({
	web: {
		auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
		client_id: 'client-id',
		client_secret: 'client-secret',
		redirect_uris: ['https://auth.claw.askluna.xyz:18900/oauth/google/callback'],
		token_uri: 'https://oauth2.googleapis.com/token',
	},
});

export function createGrant(props: {
	readonly accessTokenExpiresAtMs: number;
	readonly lifecycleKind?: 'active' | 'degraded' | 'reauthorization-required';
	readonly nextRefreshEligibleAtMs?: number | null;
}): OAuthStoredGrant {
	return oauthStoredGrantSchema.parse({
		...binding,
		accountAlias: 'Personal Google',
		envelope: envelopeCodec.encrypt({
			binding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload: {
				accessToken: 'old-access-token',
				accessTokenExpiresAtMs: props.accessTokenExpiresAtMs,
				refreshToken: 'old-refresh-token',
				authority: {
					accountAlias: 'Personal Google',
					authorizationMetadataRevision: 1,
					grantedScopes: [gmailReadScope],
					requestedScopes: [gmailReadScope],
					selectedGroupIds: ['gmail.read'],
				},
			},
		}),
		failureClass: props.lifecycleKind === 'degraded' ? 'provider-unavailable' : null,
		grantedScopes: [gmailReadScope],
		lastRefreshAttemptAtMs: null,
		lastRefreshSucceededAtMs: null,
		lifecycleKind: props.lifecycleKind ?? 'active',
		materialRevision: oauthMaterialRevisionSchema.parse(
			'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
		),
		nextRefreshEligibleAtMs: props.nextRefreshEligibleAtMs ?? null,
		providerCredentialVersion: 1,
		reauthorizationReason: null,
		recordRevision: 1,
		requestedScopes: [gmailReadScope],
		selectedGroupIds: ['gmail.read'],
		transitionId: '44444444-4444-4444-8444-444444444444',
		updatedAtMs: 1_000,
	});
}

export function createCatalog(initialGrant: OAuthStoredGrant): {
	readonly advanceRecordRevision: () => void;
	readonly catalog: Pick<OAuthCredentialCatalog, 'replaceGrantEnvelope'>;
	readonly replaceGrantEnvelope: ReturnType<typeof vi.fn>;
} {
	let currentGrant = initialGrant;
	const replaceGrantEnvelope = vi.fn((replacement: OAuthReplaceGrantEnvelopeInput) => {
		if (replacement.expectedRecordRevision !== currentGrant.recordRevision) {
			return { currentRecordRevision: currentGrant.recordRevision, kind: 'stale' as const };
		}
		currentGrant = oauthStoredGrantSchema.parse({
			...currentGrant,
			envelope: replacement.envelope,
			failureClass: replacement.failureClass,
			lastRefreshAttemptAtMs: replacement.lastRefreshAttemptAtMs,
			lastRefreshSucceededAtMs: replacement.lastRefreshSucceededAtMs,
			lifecycleKind: replacement.lifecycleKind,
			materialRevision: replacement.materialRevision,
			nextRefreshEligibleAtMs: replacement.nextRefreshEligibleAtMs,
			providerCredentialVersion: replacement.providerCredentialVersion,
			reauthorizationReason: replacement.reauthorizationReason,
			recordRevision: currentGrant.recordRevision + 1,
			updatedAtMs: replacement.lastRefreshAttemptAtMs,
		});
		return { grant: currentGrant, kind: 'updated' as const };
	});
	return {
		advanceRecordRevision: (): void => {
			currentGrant = oauthStoredGrantSchema.parse({
				...currentGrant,
				recordRevision: currentGrant.recordRevision + 1,
			});
		},
		catalog: {
			replaceGrantEnvelope,
		},
		replaceGrantEnvelope,
	};
}

export function createAdapter(refreshResult: GoogleRefreshResult): {
	readonly adapter: GoogleOAuthAdapter;
	readonly refreshAuthorization: ReturnType<typeof vi.fn>;
} {
	const refreshAuthorization = vi.fn(async () => refreshResult);
	return {
		adapter: {
			buildAuthorizationUrl: () => {
				throw new Error('Unexpected authorization URL build in refresh test.');
			},
			exchangeAuthorizationCode: async () => {
				throw new Error('Unexpected code exchange in refresh test.');
			},
			refreshAuthorization,
			revokeAuthorization: async () => {
				throw new Error('Unexpected revocation in refresh test.');
			},
			tokenLifecycle: oauthTokenLifecycleSchema.parse({
				kind: 'refreshable',
				refreshMode: 'stable-refresh-token',
			}),
		},
		refreshAuthorization,
	};
}
