import {
	oauthScopeSchema,
	type OAuthAuthorizationActionResult,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
	createBrokerFacadeFixture,
	facadeApplicationId,
	facadeIdentity,
	prepareBrokerConsent,
} from './google-broker-facade-test-fixture.js';
import { type GoogleOAuthPermissionPageData } from './google-oauth-broker-contracts.js';

describe('Google OAuth broker local disconnect and containment', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
	});
	async function disconnectPage(
		account: Extract<OAuthAuthorizationActionResult, { kind: 'authorization-completed' }>,
	): Promise<GoogleOAuthPermissionPageData> {
		if (fixture === undefined) throw new Error('Expected fixture.');
		const begun = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: {
				actionId: 'oauth_authorization.disconnect',
				accountId: account.accountId,
				applicationId: facadeApplicationId,
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected disconnect ceremony.');
		return fixture.broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
	}
	function confirmDisconnect(
		page: GoogleOAuthPermissionPageData,
	): Promise<OAuthAuthorizationActionResult> {
		if (fixture === undefined) throw new Error('Expected fixture.');
		return fixture.broker.confirmDisconnect({
			identity: facadeIdentity,
			transactionId: page.transactionId,
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
		});
	}
	it('disconnects an invalid provider grant locally without asking Google to revoke it', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({
			transformAdapter: (adapter) => ({
				...adapter,
				revokeAuthorization: async () => {
					throw new Error('No provider revocation permitted.');
				},
			}),
		});
		const account = await fixture.enroll();
		const stored = fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })[0];
		if (stored === undefined) throw new Error('Expected grant.');
		fixture.catalog.replaceGrantEnvelope({
			credentialId: stored.credentialId,
			expectedRecordRevision: stored.recordRevision,
			envelope: stored.envelope,
			failureClass: 'invalid-grant',
			lastRefreshAttemptAtMs: 1_000,
			lastRefreshSucceededAtMs: null,
			lifecycleKind: 'reauthorization-required',
			materialRevision: stored.materialRevision,
			nextRefreshEligibleAtMs: null,
			providerCredentialVersion: stored.providerCredentialVersion,
			reauthorizationReason: 'invalid-grant',
		});
		const page = await disconnectPage(account);
		const requests = fixture.providerRequests.length;
		// Act / Assert
		expect((await confirmDisconnect(page)).kind).toBe('authorization-disconnected');
		expect(fixture.providerRequests).toHaveLength(requests);
		expect(fixture.catalog.getGrant(stored.credentialId)).toBeUndefined();
	});

	it('cancels the browser disconnect confirmation without changing either agent grant', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll();
		await fixture.enroll('ember');
		const before = fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' });
		const page = await disconnectPage(account);
		const input = {
			identity: facadeIdentity,
			transactionId: page.transactionId,
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
		};
		// Act / Assert
		expect(fixture.broker.cancelBrowserTransaction({ ...input, csrfToken: 'wrong' })).toBe(false);
		expect(fixture.broker.cancelBrowserTransaction(input)).toBe(true);
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual(
			before,
		);
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'ember', zoneId: 'test-zone' }),
		).toHaveLength(1);
		expect(fixture.containments).toHaveLength(0);
		expect(fixture.broker.cancelBrowserTransaction(input)).toBe(false);
	});

	it('rejects an old disconnect confirmation after a newer reauthorization commits', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll();
		const stalePage = await disconnectPage(account);
		const replacement = await prepareBrokerConsent(fixture, {
			actionId: 'oauth_authorization.reauthorize',
			accountId: account.accountId,
			applicationId: facadeApplicationId,
		});
		const callback = await fixture.exchangeRedirect(replacement.redirect);
		if (callback.kind !== 'confirmation') throw new Error('Expected replacement confirmation.');
		expect((await fixture.confirm(callback.confirmation)).kind).toBe('completed');
		const afterReplacement = fixture.catalog.listGrantsForAgent({
			agentId: 'sun',
			zoneId: 'test-zone',
		});
		// Act / Assert
		expect(await confirmDisconnect(stalePage)).toEqual({
			kind: 'authorization-failed',
			failure: { kind: 'stale-authorization' },
		});
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual(
			afterReplacement,
		);
	});

	it('does not depend on provider availability for owner-confirmed local removal', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({
			transformAdapter: (adapter) => ({
				...adapter,
				revokeAuthorization: async () => ({
					kind: 'failed',
					failure: { kind: 'provider-unavailable', retryable: true },
				}),
			}),
		});
		const account = await fixture.enroll();
		const page = await disconnectPage(account);
		const requests = fixture.providerRequests.length;
		// Act / Assert
		expect((await confirmDisconnect(page)).kind).toBe('authorization-disconnected');
		expect(fixture.providerRequests).toHaveLength(requests);
	});

	it('can erase corrupt credential material locally, without refreshing or revoking it', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll();
		const stored = fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })[0];
		if (stored === undefined) throw new Error('Expected grant.');
		fixture.catalog.replaceGrantEnvelope({
			credentialId: stored.credentialId,
			expectedRecordRevision: stored.recordRevision,
			envelope: {
				...stored.envelope,
				payloadCiphertext:
					(stored.envelope.payloadCiphertext.startsWith('A') ? 'B' : 'A') +
					stored.envelope.payloadCiphertext.slice(1),
			},
			failureClass: 'credential-corrupt',
			lastRefreshAttemptAtMs: 1_000,
			lastRefreshSucceededAtMs: null,
			lifecycleKind: 'reauthorization-required',
			materialRevision: stored.materialRevision,
			nextRefreshEligibleAtMs: null,
			providerCredentialVersion: stored.providerCredentialVersion,
			reauthorizationReason: 'credential-corrupt',
		});
		const page = await disconnectPage(account);
		const requests = fixture.providerRequests.length;
		// Act / Assert
		expect((await confirmDisconnect(page)).kind).toBe('authorization-disconnected');
		expect(fixture.catalog.getGrant(stored.credentialId)).toBeUndefined();
		expect(fixture.providerRequests).toHaveLength(requests);
	});

	it('does not report a replacement as completed when old runtime containment fails', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({
			containAuthorizationMaterial: async () => {
				throw new Error('owner-unsafe');
			},
		});
		const account = await fixture.enroll();
		const prepared = await prepareBrokerConsent(fixture, {
			actionId: 'oauth_authorization.reauthorize',
			accountId: account.accountId,
			applicationId: facadeApplicationId,
		});
		const callback = await fixture.exchangeRedirect(prepared.redirect);
		if (callback.kind !== 'confirmation') throw new Error('Expected confirmation.');
		// Act
		expect(await fixture.confirm(callback.confirmation)).toEqual({ kind: 'containment-failed' });
		// Assert
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);
		expect(
			fixture.catalog.listAuthorizationsForAgent({ agentId: 'sun', zoneId: 'test-zone' })[0]
				?.accessState,
		).toBe('replacing');
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: prepared.publicCeremonyId,
				},
			}),
		).toMatchObject({ kind: 'authorization-containment-failed' });
	});

	it('keeps a disconnect fenced and reports containment failure rather than success', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({
			containAuthorizationMaterial: async () => 'failed',
		});
		const account = await fixture.enroll();
		const page = await disconnectPage(account);
		// Act / Assert
		expect((await confirmDisconnect(page)).kind).toBe('authorization-containment-failed');
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);
		expect(
			fixture.catalog.listAuthorizationsForAgent({ agentId: 'sun', zoneId: 'test-zone' })[0]
				?.accessState,
		).toBe('disconnecting');
	});

	it('rejects unexpected returned scopes before confirmation, without provider cleanup', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({
			transformAdapter: (adapter) => ({
				...adapter,
				exchangeAuthorizationCode: async (request) => {
					const result = await adapter.exchangeAuthorizationCode(request);
					return result.kind !== 'authorized'
						? result
						: {
								...result,
								authorization: {
									...result.authorization,
									grantedScopes: [
										...result.authorization.grantedScopes,
										oauthScopeSchema.parse('https://www.googleapis.com/auth/drive'),
									],
								},
							};
				},
			}),
		});
		const prepared = await prepareBrokerConsent(fixture);
		// Act / Assert
		expect(await fixture.exchangeRedirect(prepared.redirect)).toEqual({
			kind: 'failed',
			reason: 'scope-mismatch',
		});
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);
		expect(fixture.providerRequests.some((url) => url.includes('revoke'))).toBe(false);
	});

	it('preserves the policy companion on reconnect and lets an owner disconnect without editor admission', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll();
		const before = fixture.catalog.listAuthorizationsForAgent({
			agentId: 'sun',
			zoneId: 'test-zone',
		})[0];
		if (before === undefined) throw new Error('Expected authorization.');
		const policy = fixture.catalog.getPolicy(before.authorizationId);
		fixture.config.policyEditors = {};
		// Act
		expect((await confirmDisconnect(await disconnectPage(account))).kind).toBe(
			'authorization-disconnected',
		);
		const reconnected = await fixture.enroll();
		// Assert
		const after = fixture.catalog.listAuthorizationsForAgent({
			agentId: 'sun',
			zoneId: 'test-zone',
		})[0];
		expect(reconnected.accountId).toBe(account.accountId);
		expect(after?.authorizationId).toBe(before.authorizationId);
		expect(after?.generation).toBe(3);
		expect(after?.credentialId).not.toBe(before.credentialId);
		expect(fixture.catalog.getPolicy(before.authorizationId)).toEqual(policy);
	});
});
