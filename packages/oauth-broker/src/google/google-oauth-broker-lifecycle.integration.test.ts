import {
	oauthPermissionSelectionsSchema,
	type OAuthAuthorizationActionResult,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createBrokerFacadeFixture,
	facadeApplicationId,
	facadeIdentity,
	prepareBrokerConsent,
} from './google-broker-facade-test-fixture.js';
import { type GoogleAuthorizationCodeExchangeResult } from './google-oauth-adapter.js';
import { type GoogleOAuthConfirmationPageData } from './google-oauth-broker-contracts.js';

describe('Google OAuth broker lifecycle and policy', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
		vi.restoreAllMocks();
	});
	async function prepareConfirmation(): Promise<{
		readonly confirmation: GoogleOAuthConfirmationPageData;
		readonly prepared: Awaited<ReturnType<typeof prepareBrokerConsent>>;
	}> {
		if (fixture === undefined) throw new Error('Expected fixture.');
		const prepared = await prepareBrokerConsent(fixture);
		const result = await fixture.exchangeRedirect(prepared.redirect);
		if (result.kind !== 'confirmation') throw new Error('Expected confirmation.');
		return { confirmation: result.confirmation, prepared };
	}

	it('keeps an in-flight exchange owned when agent cancellation races it', async () => {
		// Arrange
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture = await createBrokerFacadeFixture({
			transformAdapter: (adapter) => ({
				...adapter,
				exchangeAuthorizationCode: async (input) => {
					started.resolve();
					await release.promise;
					return await adapter.exchangeAuthorizationCode(input);
				},
			}),
		});
		const prepared = await prepareBrokerConsent(fixture);
		const running = fixture.exchangeRedirect(prepared.redirect);
		await started.promise;
		// Act
		const cancelled = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.cancel', transactionId: prepared.publicCeremonyId },
		});
		release.resolve();
		// Assert
		expect(cancelled.kind).toBe('authorization-pending');
		expect((await running).kind).toBe('confirmation');
	});

	it('requires current catalog groups and configured ceiling at resolution and final snapshot checks', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll();
		const request = {
			accountId: account.accountId,
			agentId: 'sun',
			applicationId: facadeApplicationId,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
		};
		const material = await fixture.broker.resolveRuntimeCredential(request);
		if (material.kind !== 'ready') throw new Error('Expected material.');
		const sun = fixture.config.agents.sun;
		if (sun === undefined) throw new Error('Expected configured agent.');
		// Act: model a newly narrowed active snapshot; no deployment config is changed.
		sun.applications['gmail-app'] = { ceiling: { kind: 'explicit', groupIds: [] } };
		// Assert
		expect((await fixture.broker.resolveRuntimeCredential(request)).kind).toBe('unavailable');
		expect(fixture.broker.validateRuntimeCredentialSnapshot({ ...request, ...material }).kind).toBe(
			'stale',
		);
	});

	it('authenticates the current credential snapshot without refreshing and rejects altered ciphertext', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll();
		const request = {
			accountId: account.accountId,
			agentId: 'sun',
			applicationId: facadeApplicationId,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
		};
		const material = await fixture.broker.resolveRuntimeCredential(request);
		if (material.kind !== 'ready') throw new Error('Expected material.');
		const snapshot = { ...request, ...material };
		const beforeCalls = fixture.providerRequests.length;
		expect(fixture.broker.validateRuntimeCredentialSnapshot(snapshot).kind).toBe('current');
		const stored = fixture.catalog.getGrant(material.credentialId);
		if (stored === undefined) throw new Error('Expected grant.');
		// Act
		fixture.catalog.replaceGrantEnvelope({
			credentialId: stored.credentialId,
			expectedRecordRevision: stored.recordRevision,
			envelope: {
				...stored.envelope,
				payloadCiphertext:
					(stored.envelope.payloadCiphertext.startsWith('A') ? 'B' : 'A') +
					stored.envelope.payloadCiphertext.slice(1),
			},
			failureClass: null,
			lastRefreshAttemptAtMs: null,
			lastRefreshSucceededAtMs: null,
			lifecycleKind: 'active',
			materialRevision: stored.materialRevision,
			nextRefreshEligibleAtMs: null,
			providerCredentialVersion: 1,
			reauthorizationReason: null,
		});
		// Assert
		expect(fixture.broker.validateRuntimeCredentialSnapshot(snapshot).kind).toBe('stale');
		expect(fixture.providerRequests).toHaveLength(beforeCalls);
	});

	it('lists exact catalog group identifiers and rejects unsupported suggestions', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({ includeDocuments: true });
		// Act
		const listed = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.list' },
		});
		// Assert
		expect(listed).toMatchObject({
			kind: 'authorization-list',
			accounts: [],
			authorizationOptions: [
				{
					applicationId: 'gmail-app',
					services: [
						{
							serviceId: 'gmail',
							groups: expect.arrayContaining([
								{
									groupId: 'gmail.read',
									effect: 'read',
									label: 'Read Gmail',
									scopeDescriptions: expect.any(Array),
								},
							]),
						},
					],
				},
				{ applicationId: 'workspace-app', services: [{ serviceId: 'drive' }] },
			],
		});
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: {
					actionId: 'oauth_authorization.begin',
					applicationId: facadeApplicationId,
					suggestedSelections: oauthPermissionSelectionsSchema.parse({
						'gmail-app': ['unsupported.group'],
					}),
				},
			}),
		).toMatchObject({ kind: 'authorization-failed' });
	});

	it('aborts provider work and drains it before close resolves', async () => {
		// Arrange
		const started = Promise.withResolvers<void>();
		fixture = await createBrokerFacadeFixture({
			transformAdapter: (adapter) => ({
				...adapter,
				exchangeAuthorizationCode: async ({
					signal,
				}): Promise<GoogleAuthorizationCodeExchangeResult> =>
					await new Promise((resolve) => {
						started.resolve();
						signal?.addEventListener(
							'abort',
							() =>
								resolve({
									kind: 'failed',
									failure: { kind: 'provider-unavailable', retryable: true },
								}),
							{ once: true },
						);
					}),
			}),
		});
		const prepared = await prepareBrokerConsent(fixture);
		const running = fixture.exchangeRedirect(prepared.redirect);
		await started.promise;
		// Act
		fixture.broker.stopAdmission();
		await fixture.broker.drain();
		await fixture.broker.close();
		// Assert
		expect((await running).kind).toBe('failed');
		expect(fixture.broker.reapExpiredTransactions()).toEqual({
			transactionCount: 0,
			completionSessionCount: 0,
		});
		await expect(
			fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.list' },
			}),
		).rejects.toThrow('admission is closed');
	});

	it('cancels browser transactions only with matching session, secret and CSRF', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const prepared = await prepareBrokerConsent(fixture);
		const input = {
			identity: facadeIdentity,
			transactionId: prepared.page.transactionId,
			browserBindingSecret: prepared.page.browserBindingSecret,
			csrfToken: prepared.page.csrfToken,
		};
		// Act / Assert
		expect(
			fixture.broker.cancelBrowserTransaction({
				...input,
				identity: { ...facadeIdentity, sessionId: 'other' },
			}),
		).toBe(false);
		expect(fixture.broker.cancelBrowserTransaction({ ...input, csrfToken: 'wrong' })).toBe(false);
		expect(
			fixture.broker.cancelBrowserTransaction({ ...input, browserBindingSecret: 'wrong' }),
		).toBe(false);
		expect(fixture.broker.cancelBrowserTransaction(input)).toBe(true);
		expect((await fixture.exchangeRedirect(prepared.redirect)).kind).toBe('failed');
	});

	it('keeps completion ownership with the original ceremony and honors cancellation without cancelling a newer begin', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const { confirmation, prepared } = await prepareConfirmation();
		const newer = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		if (newer.kind !== 'authorization-begun') throw new Error('Expected separate bounded begin.');
		// Act
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: {
					actionId: 'oauth_authorization.cancel',
					transactionId: prepared.publicCeremonyId,
				},
			}),
		).toEqual({ kind: 'authorization-cancelled' });
		// Assert
		expect(await fixture.confirm(confirmation)).toEqual({ kind: 'authorization-denied' });
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.status', transactionId: newer.transactionId },
			}),
		).toMatchObject({ kind: 'authorization-pending' });
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);
	});

	it('returns pending if agent cancellation races the synchronous confirmation commit', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const { confirmation, prepared } = await prepareConfirmation();
		const { broker, catalog } = fixture;
		const commit = catalog.commitEnrollmentGrant.bind(catalog);
		let cancellation: Promise<OAuthAuthorizationActionResult> | undefined;
		vi.spyOn(catalog, 'commitEnrollmentGrant').mockImplementation((input) => {
			cancellation = broker.executeAuthorizationAction({
				agentId: 'sun',
				request: {
					actionId: 'oauth_authorization.cancel',
					transactionId: prepared.publicCeremonyId,
				},
			});
			return commit(input);
		});
		// Act
		const completed = await fixture.confirm(confirmation);
		// Assert
		expect(completed.kind).toBe('completed');
		expect(await cancellation).toEqual({
			kind: 'authorization-pending',
			transactionId: prepared.publicCeremonyId,
		});
		expect(catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toHaveLength(1);
	});

	it('consumes confirmation authority on a catalog failure without leaving public status pending', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const { confirmation, prepared } = await prepareConfirmation();
		vi.spyOn(fixture.catalog, 'commitEnrollmentGrant').mockImplementation(() => {
			throw new Error('forced catalog failure');
		});
		// Act
		await expect(fixture.confirm(confirmation)).rejects.toThrow('forced catalog failure');
		// Assert
		expect(await fixture.confirm(confirmation)).toEqual({ kind: 'authorization-denied' });
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: prepared.publicCeremonyId,
				},
			}),
		).toMatchObject({ kind: 'authorization-failed' });
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);
	});

	it('does not clear a newer ceremony while replacement containment is pending', async () => {
		// Arrange
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture = await createBrokerFacadeFixture({
			containAuthorizationMaterial: async () => {
				started.resolve();
				await release.promise;
				return 'contained';
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
		const running = fixture.confirm(callback.confirmation);
		await started.promise;
		const newer = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		// Act
		release.resolve();
		expect((await running).kind).toBe('completed');
		// Assert
		if (newer.kind !== 'authorization-begun') throw new Error('Expected newer ceremony.');
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.status', transactionId: newer.transactionId },
			}),
		).toMatchObject({ kind: 'authorization-pending' });
	});

	it('never returns a usable successor after shutdown races a durable first-app commit', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({ includeDocuments: true });
		const prepared = await prepareBrokerConsent(
			fixture,
			undefined,
			oauthPermissionSelectionsSchema.parse({
				'gmail-app': ['gmail.read'],
				'workspace-app': ['drive.all-files.read'],
			}),
		);
		const callback = await fixture.exchangeRedirect(prepared.redirect);
		if (callback.kind !== 'confirmation') throw new Error('Expected confirmation.');
		const { broker, catalog } = fixture;
		const commit = catalog.commitEnrollmentGrant.bind(catalog);
		vi.spyOn(catalog, 'commitEnrollmentGrant').mockImplementation((input) => {
			const result = commit(input);
			broker.stopAdmission();
			return result;
		});
		// Act / Assert
		await expect(fixture.confirm(callback.confirmation)).rejects.toThrow('admission is closed');
		expect(catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toHaveLength(1);
	});
});
