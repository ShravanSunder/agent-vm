import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthProviderIdSchema,
	oauthScopeSchema,
	oauthTokenLifecycleSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createOAuthEnvelopeCodec, oauthEnvelopeBindingSchema } from '../envelope-codec.js';
import {
	oauthStoredGrantSchema,
	type OAuthCredentialCatalog,
	type OAuthReplaceGrantEnvelopeInput,
	type OAuthStoredGrant,
} from '../oauth-credential-catalog.js';
import {
	createGoogleCredentialRefreshCoordinator,
	googleStoredCredentialPayloadSchema,
} from './google-credential-refresh-coordinator.js';
import {
	googleWebClientCredentialsSchema,
	type GoogleOAuthAdapter,
	type GoogleRefreshResult,
} from './google-oauth-adapter.js';

const keyEncryptionKey = new Uint8Array(32).fill(63);
const credentialId = oauthCredentialIdSchema.parse('11111111-1111-4111-8111-111111111111');
const accountProfileId = oauthAccountProfileIdSchema.parse('personal-google');
const applicationId = oauthApplicationIdSchema.parse('gmail-app');
const providerId = oauthProviderIdSchema.parse('google');
const gmailReadScope = oauthScopeSchema.parse('gmail.readonly');
const envelopeCodec = createOAuthEnvelopeCodec({
	payloadSchema: googleStoredCredentialPayloadSchema,
});
const binding = oauthEnvelopeBindingSchema.parse({
	accountProfileId,
	applicationId,
	credentialId,
	providerId,
	providerSubject: 'google-subject-1',
});
const clientCredentials = googleWebClientCredentialsSchema.parse({
	web: {
		auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
		client_id: 'client-id',
		client_secret: 'client-secret',
		redirect_uris: ['https://auth.claw.askluna.xyz:18900/oauth/google/callback'],
		token_uri: 'https://oauth2.googleapis.com/token',
	},
});

function createGrant(props: {
	readonly accessTokenExpiresAtMs: number;
	readonly lifecycleKind?: 'active' | 'degraded' | 'reauthorization-required';
	readonly nextRefreshEligibleAtMs?: number | null;
}): OAuthStoredGrant {
	return oauthStoredGrantSchema.parse({
		accountLabel: 'Personal Google',
		accountProfileId,
		agentId: 'hermes',
		applicationId,
		credentialId,
		envelope: envelopeCodec.encrypt({
			binding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload: {
				accessToken: 'old-access-token',
				accessTokenExpiresAtMs: props.accessTokenExpiresAtMs,
				refreshToken: 'old-refresh-token',
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
		profileRecordId: '22222222-2222-4222-8222-222222222222',
		providerCredentialVersion: 1,
		providerId,
		providerSubject: 'google-subject-1',
		reauthorizationReason: null,
		recordRevision: 1,
		updatedAtMs: 1_000,
		zoneId: 'apollofam',
	});
}

function createCatalog(initialGrant: OAuthStoredGrant): {
	readonly advanceRecordRevision: () => void;
	readonly catalog: OAuthCredentialCatalog;
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
			close: () => undefined,
			commitEnrollmentGrant: () => {
				throw new Error('Unexpected enrollment commit in refresh test.');
			},
			deleteGrantForAccountApplication: () => 'missing',
			getGrant: () => currentGrant,
			getGrantForAccountApplication: () => currentGrant,
			getStorageDiagnostics: () => ({
				busyTimeoutMs: 5_000,
				foreignKeysEnabled: true,
				journalMode: 'wal',
				synchronousMode: 2,
			}),
			listGrantsForAgent: () => [currentGrant],
			replaceGrantEnvelope,
		},
		replaceGrantEnvelope,
	};
}

function createAdapter(refreshResult: GoogleRefreshResult): {
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

describe('Google credential refresh coordinator', () => {
	it('does not persist degraded lifecycle state when controller shutdown aborts refresh', async () => {
		// Arrange
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000 });
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const refreshStarted = Promise.withResolvers<void>();
		const { adapter } = createAdapter({
			failure: { kind: 'provider-unavailable', retryable: true },
			kind: 'failed',
		});
		const refreshAuthorization = vi.fn(
			async ({ signal }: Parameters<GoogleOAuthAdapter['refreshAuthorization']>[0]) =>
				await new Promise<GoogleRefreshResult>((resolve) => {
					refreshStarted.resolve();
					signal?.addEventListener(
						'abort',
						() =>
							resolve({
								failure: { kind: 'provider-unavailable', retryable: true },
								kind: 'failed',
							}),
						{ once: true },
					);
				}),
		);
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: { ...adapter, refreshAuthorization },
			now: () => 10_000,
		});
		const controllerShutdown = new AbortController();
		const shutdownReason = new Error('controller OAuth shutdown');

		// Act
		const resolution = coordinator.resolveAccessToken({
			clientCredentials,
			grant,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			requiredScopes: [gmailReadScope],
			signal: controllerShutdown.signal,
		});
		await refreshStarted.promise;
		controllerShutdown.abort(shutdownReason);

		// Assert
		await expect(resolution).rejects.toBe(shutdownReason);
		expect(replaceGrantEnvelope).not.toHaveBeenCalled();
	});

	it('single-flights concurrent refresh and atomically persists a replacement token', async () => {
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000 });
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const { adapter, refreshAuthorization } = createAdapter({
			accessToken: 'new-access-token',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [gmailReadScope],
			kind: 'refreshed',
			replacementRefreshToken: 'rotated-refresh-token',
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
			now: () => 10_000,
		});
		const results = await Promise.all(
			Array.from(
				{ length: 5 },
				async () =>
					await coordinator.resolveAccessToken({
						clientCredentials,
						grant,
						keyEncryptionKey,
						keyEncryptionKeyVersion: 1,
						requiredScopes: [gmailReadScope],
					}),
			),
		);

		expect(results).toEqual(
			Array.from({ length: 5 }, () =>
				expect.objectContaining({ accessToken: 'new-access-token', kind: 'ready' }),
			),
		);
		expect(refreshAuthorization).toHaveBeenCalledOnce();
		expect(replaceGrantEnvelope).toHaveBeenCalledOnce();
		const ready = results[0];
		if (ready?.kind !== 'ready') throw new Error('Expected refreshed credential.');
		expect(
			envelopeCodec.decrypt({
				binding,
				envelope: ready.grant.envelope,
				keyEncryptionKey,
			}),
		).toMatchObject({ refreshToken: 'rotated-refresh-token' });
	});

	it('rejects an in-flight refresh after reauthorization advances the grant revision', async () => {
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000 });
		const { advanceRecordRevision, catalog } = createCatalog(grant);
		let resolveRefreshStarted: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			resolveRefreshStarted = resolve;
		});
		let resolveRefresh: ((result: GoogleRefreshResult) => void) | undefined;
		const refreshResult = new Promise<GoogleRefreshResult>((resolve) => {
			resolveRefresh = resolve;
		});
		const { adapter } = createAdapter({
			accessToken: 'unused',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [gmailReadScope],
			kind: 'refreshed',
		});
		const refreshAuthorization = vi.fn(async (): Promise<GoogleRefreshResult> => {
			resolveRefreshStarted?.();
			return await refreshResult;
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: { ...adapter, refreshAuthorization },
			now: () => 10_000,
		});
		const resolution = coordinator.resolveAccessToken({
			clientCredentials,
			grant,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			requiredScopes: [gmailReadScope],
		});
		await refreshStarted;
		advanceRecordRevision();
		resolveRefresh?.({
			accessToken: 'superseded-refresh-access-token',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [gmailReadScope],
			kind: 'refreshed',
		});

		await expect(resolution).resolves.toEqual({ kind: 'stale-write' });
	});

	it('reuses a sufficiently valid access token without provider or catalog effects', async () => {
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000_000 });
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const { adapter, refreshAuthorization } = createAdapter({
			failure: { kind: 'provider-unavailable', retryable: true },
			kind: 'failed',
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
			now: () => 10_000,
		});
		expect(
			await coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailReadScope],
			}),
		).toMatchObject({ accessToken: 'old-access-token', kind: 'ready' });
		expect(refreshAuthorization).not.toHaveBeenCalled();
		expect(replaceGrantEnvelope).not.toHaveBeenCalled();
	});

	it('persists invalid_grant as reauthorization-required', async () => {
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000 });
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const { adapter } = createAdapter({ failure: { kind: 'invalid-grant' }, kind: 'failed' });
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
			now: () => 10_000,
		});
		expect(
			await coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailReadScope],
			}),
		).toEqual({ kind: 'reauthorization-required' });
		expect(replaceGrantEnvelope).toHaveBeenCalledWith(
			expect.objectContaining({
				failureClass: 'invalid-grant',
				lifecycleKind: 'reauthorization-required',
				reauthorizationReason: 'invalid-grant',
			}),
		);
	});

	it('honors degraded backoff without another provider attempt', async () => {
		const grant = createGrant({
			accessTokenExpiresAtMs: 1_000,
			lifecycleKind: 'degraded',
			nextRefreshEligibleAtMs: 20_000,
		});
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const { adapter, refreshAuthorization } = createAdapter({
			accessToken: 'must-not-run',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [gmailReadScope],
			kind: 'refreshed',
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
			now: () => 10_000,
		});
		expect(
			await coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailReadScope],
			}),
		).toEqual({ kind: 'degraded', nextRefreshEligibleAtMs: 20_000 });
		expect(refreshAuthorization).not.toHaveBeenCalled();
		expect(replaceGrantEnvelope).not.toHaveBeenCalled();
	});
});
