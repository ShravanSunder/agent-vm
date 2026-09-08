import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { oauthScopeSchema } from '@agent-vm/oauth-broker-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enrollmentInput, owner } from '../oauth-catalog-test-fixture.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import { openOAuthCredentialCatalog } from '../oauth-credential-catalog.js';
import {
	callbackApplicationId,
	callbackIdentity,
	createCallbackTestFixture,
} from './google-callback-test-fixture.js';

describe('Google callback with dynamic accounts and exact browser identity', () => {
	let catalog: OAuthCredentialCatalog;
	beforeEach(async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-callback-'));
		catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
	});
	afterEach(() => {
		catalog.close();
	});

	it('creates a separate confirmation for a second agent without copying or changing the first grant', async () => {
		// Arrange: real SQLite, envelopes and ceremony store; fake Google exchange only.
		const existing = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		expect(catalog.commitEnrollmentGrant(existing).kind).toBe('committed');
		const before = catalog.getGrant(existing.credentialId);
		const fixture = createCallbackTestFixture(catalog);
		const request = fixture.begin({ agentId: 'ember' });

		// Act
		const result = await fixture.callback.handleGoogleCallback(request);

		// Assert
		expect(result).toMatchObject({
			kind: 'confirmation',
			confirmation: { grantedPermissionLabels: ['Read Gmail'] },
		});
		expect(catalog.getGrant(existing.credentialId)).toEqual(before);
		expect(catalog.listAuthorizationsForAgent({ agentId: 'ember', zoneId: 'test-zone' })).toEqual(
			[],
		);
		expect(fixture.exchangeAuthorizationCode).toHaveBeenCalledOnce();
		expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
		expect(await fixture.callback.handleGoogleCallback(request)).toMatchObject({ kind: 'failed' });
		expect(fixture.exchangeAuthorizationCode).toHaveBeenCalledOnce();
	});

	it.each(['userId', 'sessionId', 'issuer'] as const)(
		'rejects a changed %s before Google exchange',
		async (field) => {
			// Arrange
			const fixture = createCallbackTestFixture(catalog);
			const request = fixture.begin();
			// Act
			const result = await fixture.callback.handleGoogleCallback({
				...request,
				identity: {
					...callbackIdentity,
					[field]: field === 'issuer' ? 'https://other.example.test' : 'other',
				},
			});
			// Assert
			expect(result).toEqual({ kind: 'failed', reason: 'identity-mismatch' });
			expect(fixture.exchangeAuthorizationCode).not.toHaveBeenCalled();
		},
	);

	it.each(['config', 'owner', 'admission'] as const)(
		'rejects stale %s before exchanging',
		async (stale) => {
			// Arrange
			const fixture = createCallbackTestFixture(catalog);
			const request = fixture.begin({
				configRevision: stale === 'config' ? 'old-config' : 'test-config',
			});
			if (stale === 'owner') delete fixture.config.owners.owner;
			if (stale === 'admission') fixture.stopAdmission();
			// Act
			const result = await fixture.callback.handleGoogleCallback(request);
			// Assert
			expect(result.kind).toBe('failed');
			expect(fixture.exchangeAuthorizationCode).not.toHaveBeenCalled();
		},
	);

	it('rejects another owner without disclosing that owner or changing their authorization', async () => {
		// Arrange
		const existing = enrollmentInput({
			accountId: randomUUID(),
			agentId: 'sun',
			ownerUserId: 'other-owner',
		});
		expect(catalog.commitEnrollmentGrant(existing).kind).toBe('committed');
		const before = catalog.getGrant(existing.credentialId);
		const fixture = createCallbackTestFixture(catalog);
		// Act
		const result = await fixture.callback.handleGoogleCallback(fixture.begin({ agentId: 'ember' }));
		// Assert
		expect(result).toEqual({ kind: 'failed', reason: 'authorization-denied' });
		expect(catalog.getGrant(existing.credentialId)).toEqual(before);
		expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
	});

	it('rejects duplicate enrollment rather than silently replacing it', async () => {
		// Arrange
		const existing = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		expect(catalog.commitEnrollmentGrant(existing).kind).toBe('committed');
		const before = catalog.getGrant(existing.credentialId);
		const fixture = createCallbackTestFixture(catalog);
		// Act
		const result = await fixture.callback.handleGoogleCallback(fixture.begin());
		// Assert
		expect(result).toEqual({ kind: 'failed', reason: 'duplicate-authorization' });
		expect(catalog.getGrant(existing.credentialId)).toEqual(before);
		expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
	});

	it('permits fresh confirmation for a disconnected tuple, without restoring its old credential', async () => {
		// Arrange
		const existing = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		expect(catalog.commitEnrollmentGrant(existing).kind).toBe('committed');
		const disconnected = catalog.disconnectAuthorization({
			authorizationId: existing.authorizationId,
			expectedRecordRevision: 1,
			owner,
		});
		if (disconnected.kind !== 'updated') throw new Error('Expected disconnect fence.');
		const authorization = disconnected.authorization;
		expect(
			catalog.settleAuthorizationTransition({
				authorizationId: authorization.authorizationId,
				expectedRecordRevision: authorization.recordRevision,
				transitionId: authorization.transitionId,
			}).kind,
		).toBe('updated');
		const fixture = createCallbackTestFixture(catalog);
		// Act
		const result = await fixture.callback.handleGoogleCallback(fixture.begin());
		// Assert
		expect(result.kind).toBe('confirmation');
		expect(catalog.getGrant(existing.credentialId)).toBeUndefined();
		expect(catalog.getAuthorization(existing.authorizationId)?.accessState).toBe('disconnected');
	});

	it('keeps multi-application enrollment pinned to the previously confirmed subject', async () => {
		// Arrange
		const existing = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		expect(catalog.commitEnrollmentGrant(existing).kind).toBe('committed');
		const fixture = createCallbackTestFixture(catalog);
		fixture.exchangeAuthorizationCode.mockResolvedValueOnce({
			kind: 'authorized',
			authorization: { ...fixture.authorization, accountSubject: 'different-subject' },
		});
		// Act
		const result = await fixture.callback.handleGoogleCallback(
			fixture.begin({
				agentId: 'ember',
				target: {
					kind: 'enroll',
					applicationId: callbackApplicationId,
					accountBinding: {
						accountId: existing.accountId,
						providerSubject: existing.providerSubject,
					},
				},
			}),
		);
		// Assert
		expect(result).toEqual({ kind: 'failed', reason: 'subject-mismatch' });
		expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
	});

	it.each(['expired', 'cancelled', 'stopped'] as const)(
		'discards the candidate when %s during exchange',
		async (failure) => {
			// Arrange
			const fixture = createCallbackTestFixture(catalog);
			const request = fixture.begin();
			fixture.exchangeAuthorizationCode.mockImplementationOnce(async () => {
				if (failure === 'expired') fixture.advanceTime(600_001);
				if (failure === 'cancelled') fixture.store.cancelBrowserCeremonies(callbackIdentity);
				if (failure === 'stopped') fixture.stopAdmission();
				return { kind: 'authorized', authorization: fixture.authorization };
			});
			// Act
			const result = await fixture.callback.handleGoogleCallback(request);
			// Assert
			expect(result.kind).toBe('failed');
			expect(fixture.store.getTransaction(request.transactionId)).toBeUndefined();
			expect(catalog.listAuthorizationsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual(
				[],
			);
			expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
		},
	);

	it('rejects scope expansion and never revokes the existing project authorization', async () => {
		// Arrange
		const fixture = createCallbackTestFixture(catalog);
		fixture.exchangeAuthorizationCode.mockResolvedValueOnce({
			kind: 'authorized',
			authorization: {
				...fixture.authorization,
				grantedScopes: [
					...fixture.authorization.grantedScopes,
					oauthScopeSchema.parse('https://www.googleapis.com/auth/gmail.modify'),
				],
			},
		});
		// Act
		const result = await fixture.callback.handleGoogleCallback(fixture.begin());
		// Assert
		expect(result).toEqual({ kind: 'failed', reason: 'scope-mismatch' });
		expect(fixture.prepareCallbackRetry).not.toHaveBeenCalled();
		expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
	});

	it('requires the same browser session and CSRF binding for a retry', () => {
		// Arrange
		const fixture = createCallbackTestFixture(catalog);
		const request = fixture.begin();
		// Act / Assert
		expect(fixture.callback.getRetryPage(request)).toEqual({
			completed: [],
			csrfToken: request.csrfToken,
			retryable: [callbackApplicationId],
		});
		expect(() =>
			fixture.callback.getRetryPage({
				...request,
				identity: { ...callbackIdentity, sessionId: 'other' },
			}),
		).toThrow('authority is invalid');
		expect(() =>
			fixture.callback.retryApplication({
				...request,
				identity: { ...callbackIdentity, sessionId: 'other' },
			}),
		).toThrow();
		expect(() => fixture.callback.retryApplication({ ...request, csrfToken: 'wrong' })).toThrow();
		expect(fixture.buildAuthorizationUrl).not.toHaveBeenCalled();
		expect(fixture.callback.retryApplication(request).kind).toBe('redirect');
		expect(fixture.buildAuthorizationUrl).toHaveBeenCalledOnce();
	});

	it.each(['before', 'during'] as const)(
		'rejects a disconnect %s reauthorization exchange',
		async (timing) => {
			// Arrange
			const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
			expect(catalog.commitEnrollmentGrant(input).kind).toBe('committed');
			const fixture = createCallbackTestFixture(catalog);
			const request = fixture.begin({
				target: {
					kind: 'reauthorize',
					accountId: input.accountId,
					applicationId: input.applicationId,
					authorizationId: input.authorizationId,
					authorizationMetadataRevision: input.authorizationMetadataRevision,
					generation: input.generation,
					providerSubject: input.providerSubject,
				},
			});
			const disconnect = (): void => {
				expect(
					catalog.disconnectAuthorization({
						authorizationId: input.authorizationId,
						expectedRecordRevision: 1,
						owner,
					}).kind,
				).toBe('updated');
			};
			if (timing === 'before') disconnect();
			else
				fixture.exchangeAuthorizationCode.mockImplementationOnce(async () => {
					disconnect();
					return { kind: 'authorized', authorization: fixture.authorization };
				});
			// Act
			const result = await fixture.callback.handleGoogleCallback(request);
			// Assert
			expect(result).toEqual({ kind: 'failed', reason: 'stale-authorization' });
			expect(fixture.exchangeAuthorizationCode).toHaveBeenCalledTimes(timing === 'before' ? 0 : 1);
			expect(catalog.getGrant(input.credentialId)).toBeUndefined();
			expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
		},
	);

	it('does not stale a reauthorization merely because normal refresh changes the CAS revision', async () => {
		// Arrange
		const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		expect(catalog.commitEnrollmentGrant(input).kind).toBe('committed');
		const fixture = createCallbackTestFixture(catalog);
		const request = fixture.begin({
			target: {
				kind: 'reauthorize',
				accountId: input.accountId,
				applicationId: input.applicationId,
				authorizationId: input.authorizationId,
				authorizationMetadataRevision: input.authorizationMetadataRevision,
				generation: input.generation,
				providerSubject: input.providerSubject,
			},
		});
		fixture.exchangeAuthorizationCode.mockImplementationOnce(async () => {
			expect(
				catalog.replaceGrantEnvelope({
					credentialId: input.credentialId,
					envelope: input.envelope,
					expectedRecordRevision: 1,
					failureClass: null,
					lastRefreshAttemptAtMs: 1_000,
					lastRefreshSucceededAtMs: 1_000,
					lifecycleKind: 'active',
					materialRevision: input.materialRevision,
					nextRefreshEligibleAtMs: null,
					providerCredentialVersion: 2,
					reauthorizationReason: null,
				}).kind,
			).toBe('updated');
			return { kind: 'authorized', authorization: fixture.authorization };
		});
		// Act
		const result = await fixture.callback.handleGoogleCallback(request);
		// Assert
		expect(result).toMatchObject({
			kind: 'confirmation',
			confirmation: {
				previousPermissionLabels: ['Read Gmail'],
				grantedPermissionLabels: ['Read Gmail'],
			},
		});
		expect(catalog.getGrant(input.credentialId)?.recordRevision).toBe(2);
		expect(catalog.getGrant(input.credentialId)?.authorizationMetadataRevision).toBe(1);
	});

	it('does not invent prior permissions for a new enrollment', async () => {
		// Arrange
		const fixture = createCallbackTestFixture(catalog);
		const request = fixture.begin();
		// Act
		const result = await fixture.callback.handleGoogleCallback(request);
		// Assert
		expect(result).toMatchObject({ kind: 'confirmation' });
		if (result.kind !== 'confirmation') throw new Error('Expected account confirmation.');
		expect(result.confirmation.previousPermissionLabels).toBeUndefined();
		expect(
			fixture.callback.getConfirmationPage({
				browserBindingSecret: result.confirmation.browserBindingSecret,
				completionSessionId: result.confirmation.completionSessionId,
				identity: callbackIdentity,
			}),
		).toEqual(result.confirmation);
		expect(() =>
			fixture.callback.getConfirmationPage({
				browserBindingSecret: 'wrong-binding',
				completionSessionId: result.confirmation.completionSessionId,
				identity: callbackIdentity,
			}),
		).toThrow('authority is invalid');
		expect(() =>
			fixture.callback.getConfirmationPage({
				browserBindingSecret: result.confirmation.browserBindingSecret,
				completionSessionId: result.confirmation.completionSessionId,
				identity: { ...callbackIdentity, sessionId: 'wrong-session' },
			}),
		).toThrow('authority is invalid');
	});

	it('refuses a reauthorization diff when the prior credential payload cannot be authenticated', async () => {
		// Arrange
		const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		const firstCiphertextCharacter = input.envelope.payloadCiphertext[0];
		if (firstCiphertextCharacter === undefined)
			throw new Error('Expected encrypted payload bytes.');
		const corruptedInput = {
			...input,
			envelope: {
				...input.envelope,
				payloadCiphertext: `${firstCiphertextCharacter === 'A' ? 'B' : 'A'}${input.envelope.payloadCiphertext.slice(1)}`,
			},
		};
		expect(catalog.commitEnrollmentGrant(corruptedInput).kind).toBe('committed');
		const fixture = createCallbackTestFixture(catalog);
		const request = fixture.begin({
			target: {
				kind: 'reauthorize',
				accountId: input.accountId,
				applicationId: input.applicationId,
				authorizationId: input.authorizationId,
				authorizationMetadataRevision: input.authorizationMetadataRevision,
				generation: input.generation,
				providerSubject: input.providerSubject,
			},
		});
		// Act
		const result = await fixture.callback.handleGoogleCallback(request);
		// Assert
		expect(result).toEqual({ kind: 'failed', reason: 'unavailable' });
		expect(fixture.exchangeAuthorizationCode).not.toHaveBeenCalled();
	});

	it('catches a competing enrollment committed while Google exchange was pending', async () => {
		// Arrange
		const fixture = createCallbackTestFixture(catalog);
		const request = fixture.begin();
		const winner = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		fixture.exchangeAuthorizationCode.mockImplementationOnce(async () => {
			expect(catalog.commitEnrollmentGrant(winner).kind).toBe('committed');
			return { kind: 'authorized', authorization: fixture.authorization };
		});
		// Act
		const result = await fixture.callback.handleGoogleCallback(request);
		// Assert
		expect(result).toEqual({ kind: 'failed', reason: 'duplicate-authorization' });
		expect(catalog.getGrant(winner.credentialId)?.generation).toBe(1);
		expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
	});

	it.each(['missing-scope', 'provider-unavailable'] as const)(
		'delegates %s to the bounded retry owner without writing a grant',
		async (failure) => {
			// Arrange
			const fixture = createCallbackTestFixture(catalog);
			const request = fixture.begin();
			fixture.exchangeAuthorizationCode.mockResolvedValueOnce(
				failure === 'missing-scope'
					? {
							kind: 'authorized',
							authorization: {
								...fixture.authorization,
								grantedScopes: [oauthScopeSchema.parse('openid')],
							},
						}
					: { kind: 'failed', failure: { kind: 'provider-unavailable', retryable: true } },
			);
			fixture.prepareCallbackRetry.mockReturnValueOnce({
				kind: 'partial-completion',
				completed: [],
				retryable: ['gmail-app'],
				retryCsrfToken: request.csrfToken,
				retry: {
					kind: 'redirect',
					applicationId: callbackApplicationId,
					applicationLabel: 'Gmail',
					authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
					browserBindingSecret: request.browserBindingSecret,
					expiresAtMs: 601_000,
					transactionId: request.transactionId,
				},
			});
			// Act
			const result = await fixture.callback.handleGoogleCallback(request);
			// Assert
			expect(result.kind).toBe('partial-completion');
			expect(fixture.prepareCallbackRetry).toHaveBeenCalledOnce();
			expect(catalog.listAuthorizationsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual(
				[],
			);
			expect(fixture.revokeAuthorization).not.toHaveBeenCalled();
		},
	);
});
