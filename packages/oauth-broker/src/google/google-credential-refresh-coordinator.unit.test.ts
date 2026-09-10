import { describe, expect, it, vi } from 'vitest';

import { oauthStoredGrantSchema } from '../oauth-credential-catalog-contracts.js';
import { createGoogleCredentialRefreshCoordinator } from './google-credential-refresh-coordinator.js';
import {
	binding,
	clientCredentials,
	createAdapter,
	createCatalog,
	createGrant,
	envelopeCodec,
	gmailReadScope,
	gmailWriteScope,
	keyEncryptionKey,
} from './google-credential-refresh-test-fixture.js';
import type { GoogleOAuthAdapter, GoogleRefreshResult } from './google-oauth-adapter.js';

describe('Google credential refresh coordinator', () => {
	it.each([
		['accountAlias', 'spoofed alias'],
		['grantedScopes', [gmailReadScope, gmailWriteScope]],
		['requestedScopes', [gmailReadScope, gmailWriteScope]],
		['selectedGroupIds', ['gmail.read', 'gmail.write']],
		['authorizationMetadataRevision', 2],
	] as const)(
		'rejects unauthenticated %s changes before using or refreshing a token',
		async (field, value) => {
			// Arrange
			const grant = oauthStoredGrantSchema.parse({
				...createGrant({ accessTokenExpiresAtMs: 1_000_000 }),
				[field]: value,
			});
			const { catalog } = createCatalog(grant);
			const { adapter, refreshAuthorization } = createAdapter({
				kind: 'failed',
				failure: { kind: 'provider-unavailable', retryable: true },
			});
			const coordinator = createGoogleCredentialRefreshCoordinator({
				catalog,
				googleAdapter: adapter,
				now: () => 10_000,
			});

			// Act / Assert
			await expect(
				coordinator.resolveAccessToken({
					clientCredentials,
					grant,
					keyEncryptionKey,
					keyEncryptionKeyVersion: 1,
					requiredScopes: [gmailReadScope],
				}),
			).resolves.toEqual({ kind: 'reauthorization-required' });
			expect(refreshAuthorization).not.toHaveBeenCalled();
		},
	);

	it('rejects a different resolved Google client without rewriting the stored authorization', async () => {
		// Arrange
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000_000 });
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const { adapter, refreshAuthorization } = createAdapter({
			kind: 'failed',
			failure: { kind: 'provider-unavailable', retryable: true },
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
		});

		// Act / Assert
		await expect(
			coordinator.resolveAccessToken({
				clientCredentials: { web: { ...clientCredentials.web, client_id: 'different-client' } },
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailReadScope],
			}),
		).resolves.toEqual({ kind: 'reauthorization-required' });
		expect(refreshAuthorization).not.toHaveBeenCalled();
		expect(replaceGrantEnvelope).not.toHaveBeenCalled();
	});

	it('does not share an in-flight credential with a different agent binding', async () => {
		// Arrange
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000 });
		const { catalog } = createCatalog(grant);
		const pending = Promise.withResolvers<GoogleRefreshResult>();
		const started = Promise.withResolvers<void>();
		const { adapter } = createAdapter({
			kind: 'failed',
			failure: { kind: 'provider-unavailable', retryable: true },
		});
		const refreshAuthorization = vi.fn(async (): Promise<GoogleRefreshResult> => {
			started.resolve();
			return await pending.promise;
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: { ...adapter, refreshAuthorization },
			now: () => 10_000,
		});
		const request = {
			clientCredentials,
			grant,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			requiredScopes: [gmailReadScope],
		};

		// Act
		const leader = coordinator.resolveAccessToken(request);
		await started.promise;
		const follower = await coordinator.resolveAccessToken({
			...request,
			grant: { ...grant, agentId: 'ember' },
		});
		pending.resolve({
			kind: 'refreshed',
			accessToken: 'new-token',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [gmailReadScope],
		});

		// Assert
		expect(follower).toEqual({ kind: 'stale-write' });
		expect(await leader).toMatchObject({
			kind: 'ready',
			grant: { agentId: 'sun', authorizationMetadataRevision: 1 },
		});
		expect(refreshAuthorization).toHaveBeenCalledOnce();
	});

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

		expect(results).toHaveLength(5);
		for (const result of results) {
			expect(result).toMatchObject({ accessToken: 'new-access-token', kind: 'ready' });
		}
		expect(refreshAuthorization).toHaveBeenCalledOnce();
		expect(replaceGrantEnvelope).toHaveBeenCalledOnce();
		const ready = results[0];
		if (ready?.kind !== 'ready') throw new Error('Expected refreshed credential.');
		expect(ready.grant.authorizationMetadataRevision).toBe(grant.authorizationMetadataRevision);
		expect(
			envelopeCodec.decrypt({
				binding,
				envelope: ready.grant.envelope,
				keyEncryptionKey,
			}),
		).toMatchObject({ refreshToken: 'rotated-refresh-token' });
	});

	it('rechecks each single-flight follower scope requirement', async () => {
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000 });
		const { catalog } = createCatalog(grant);
		const { adapter, refreshAuthorization } = createAdapter({
			accessToken: 'new-read-access-token',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [gmailReadScope],
			kind: 'refreshed',
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
			now: () => 10_000,
		});

		const [readResult, writeResult] = await Promise.all([
			coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailReadScope],
			}),
			coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailWriteScope],
			}),
		]);

		expect(readResult).toMatchObject({ kind: 'ready' });
		expect(writeResult).toEqual({ kind: 'scope-insufficient' });
		expect(refreshAuthorization).toHaveBeenCalledOnce();
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

	it('persists a refresh scope mismatch as reauthorization-required', async () => {
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000 });
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const { adapter, refreshAuthorization } = createAdapter({
			accessToken: 'scope-reduced-access-token',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [],
			kind: 'refreshed',
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
			now: () => 10_000,
		});

		await expect(
			coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailReadScope],
			}),
		).resolves.toEqual({ kind: 'reauthorization-required' });
		expect(refreshAuthorization).toHaveBeenCalledOnce();
		expect(replaceGrantEnvelope).toHaveBeenCalledWith(
			expect.objectContaining({
				failureClass: 'scope-insufficient',
				lifecycleKind: 'reauthorization-required',
				reauthorizationReason: 'scope-insufficient',
			}),
		);
	});

	it('persists an authenticated-envelope failure as credential-corrupt', async () => {
		const originalGrant = createGrant({ accessTokenExpiresAtMs: 1_000_000 });
		const grant = oauthStoredGrantSchema.parse({
			...originalGrant,
			envelope: {
				...originalGrant.envelope,
				payloadCiphertext: `${originalGrant.envelope.payloadCiphertext.startsWith('A') ? 'B' : 'A'}${originalGrant.envelope.payloadCiphertext.slice(1)}`,
			},
		});
		const { catalog, replaceGrantEnvelope } = createCatalog(grant);
		const { adapter, refreshAuthorization } = createAdapter({
			accessToken: 'must-not-refresh',
			accessTokenExpiresAtMs: 1_000_000,
			grantedScopes: [gmailReadScope],
			kind: 'refreshed',
		});
		const coordinator = createGoogleCredentialRefreshCoordinator({
			catalog,
			googleAdapter: adapter,
			now: () => 10_000,
		});

		await expect(
			coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: [gmailReadScope],
			}),
		).resolves.toEqual({ kind: 'reauthorization-required' });
		expect(refreshAuthorization).not.toHaveBeenCalled();
		expect(replaceGrantEnvelope).toHaveBeenCalledWith(
			expect.objectContaining({
				failureClass: 'credential-corrupt',
				lifecycleKind: 'reauthorization-required',
				reauthorizationReason: 'credential-corrupt',
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
