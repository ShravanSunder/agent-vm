import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthServiceIdSchema,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import {
	type GoogleOAuthBrokerService,
	type GoogleOAuthConfirmationPageData,
} from './google-oauth-broker-contracts.js';
import {
	catalog,
	config,
	createAdapter,
	createService,
	enrollGmail,
	redirectUri,
} from './google-oauth-broker-test-fixture.js';

async function prepareAccountConfirmation(props: {
	readonly selections: ReturnType<typeof oauthPermissionSelectionsSchema.parse>;
	readonly service: GoogleOAuthBrokerService;
}): Promise<{
	readonly confirmation: GoogleOAuthConfirmationPageData;
	readonly publicCeremonyId: OAuthTransactionId;
}> {
	const begun = await props.service.executeAuthorizationAction({
		agentId: 'hermes',
		request: {
			actionId: 'oauth_authorization.begin',
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
		},
	});
	if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
	const page = props.service.getPermissionPage({
		tailnetLogin: 'human@example.test',
		transactionId: begun.transactionId,
	});
	const redirect = props.service.submitPermissions({
		browserBindingSecret: page.browserBindingSecret,
		csrfToken: page.csrfToken,
		selections: props.selections,
		tailnetLogin: 'human@example.test',
		transactionId: begun.transactionId,
	});
	if (redirect.kind !== 'redirect') throw new Error('Expected provider redirect.');
	const oauthState = new URL(redirect.authorizationUrl).searchParams.get('state');
	if (oauthState === null) throw new Error('Provider redirect omitted OAuth state.');
	const callback = await props.service.handleGoogleCallback({
		authorizationCode: 'race-test-code',
		browserBindingSecret: redirect.browserBindingSecret,
		oauthState,
		redirectUri,
		tailnetLogin: 'human@example.test',
		transactionId: redirect.transactionId,
	});
	if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');
	return { confirmation: callback.confirmation, publicCeremonyId: begun.transactionId };
}

describe('Google OAuth broker lifecycle and policy', () => {
	it('keeps an in-flight callback authoritative when agent cancellation races the exchange', async () => {
		const exchangeStarted = Promise.withResolvers<void>();
		const releaseExchange = Promise.withResolvers<void>();
		const baseAdapter = createAdapter();
		const service = await createService({
			adapter: {
				...baseAdapter,
				exchangeAuthorizationCode: async (exchangeProps) => {
					exchangeStarted.resolve();
					await releaseExchange.promise;
					return await baseAdapter.exchangeAuthorizationCode(exchangeProps);
				},
			},
		});
		const begun = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		const redirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected Google redirect.');
		const oauthState = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (oauthState === null) throw new Error('Google redirect omitted OAuth state.');
		const callback = service.handleGoogleCallback({
			authorizationCode: 'callback-cancel-race-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: redirect.transactionId,
		});
		await exchangeStarted.promise;

		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.cancel',
					transactionId: begun.transactionId,
				},
			}),
		).toEqual({ kind: 'authorization-pending', transactionId: begun.transactionId });
		releaseExchange.resolve();
		await expect(callback).resolves.toMatchObject({ kind: 'confirmation' });
	});

	it('requires configured read and write scopes at every write-capability gate', async () => {
		const enrollmentService = await createService();
		await enrollGmail(enrollmentService, 'write');
		const currentCatalog = catalog;
		if (currentCatalog === undefined) throw new Error('Expected OAuth credential catalog.');
		const grant = currentCatalog.getGrantForAccountApplication({
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			agentId: 'hermes',
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			zoneId: 'apollofam',
		});
		if (grant === undefined) throw new Error('Expected enrolled write grant.');
		const changedPolicyService = await createService({
			catalog: currentCatalog,
			oauthConfig: config({ gmailReadScope: 'gmail.metadata' }),
		});

		expect(
			changedPolicyService.resolveToolAvailability({
				agentId: 'hermes',
				requirement: {
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
					kind: 'oauth-account-profile',
					minimumPermission: 'write',
					serviceId: oauthServiceIdSchema.parse('gmail'),
				},
			}),
		).toEqual({ kind: 'scope-insufficient' });
		await expect(
			changedPolicyService.resolveRuntimeCredential({
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				agentId: 'hermes',
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				minimumPermission: 'write',
				serviceId: oauthServiceIdSchema.parse('gmail'),
			}),
		).resolves.toEqual({ kind: 'unavailable', reason: 'scope-insufficient' });
		expect(
			changedPolicyService.validateRuntimeCredentialSnapshot({
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				agentId: 'hermes',
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				credentialId: grant.credentialId,
				materialRevision: grant.materialRevision,
				minimumPermission: 'write',
				serviceId: oauthServiceIdSchema.parse('gmail'),
			}),
		).toEqual({ kind: 'stale', reason: 'scope-insufficient' });
	});

	it('validates the exact current runtime credential snapshot without decrypting it', async () => {
		const service = await createService();
		await enrollGmail(service);
		const runtimeCredential = await service.resolveRuntimeCredential({
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			agentId: 'hermes',
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			minimumPermission: 'read',
			serviceId: oauthServiceIdSchema.parse('gmail'),
		});
		if (runtimeCredential.kind !== 'ready') throw new Error('Expected runtime credential.');
		const snapshot = {
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			agentId: 'hermes',
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			credentialId: runtimeCredential.credentialId,
			materialRevision: runtimeCredential.materialRevision,
			minimumPermission: 'read',
			serviceId: oauthServiceIdSchema.parse('gmail'),
		} as const;

		expect(service.validateRuntimeCredentialSnapshot(snapshot)).toEqual({ kind: 'current' });
		const currentCatalog = catalog;
		if (currentCatalog === undefined) throw new Error('Expected OAuth credential catalog.');
		const grant = currentCatalog.getGrant(runtimeCredential.credentialId);
		if (grant === undefined) throw new Error('Expected stored OAuth grant.');
		const reauthorization = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.reauthorize',
				accountProfileId: snapshot.accountProfileId,
				applicationId: snapshot.applicationId,
			},
		});
		if (reauthorization.kind !== 'authorization-begun') {
			throw new Error('Expected reauthorization to begin.');
		}
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: reauthorization.transactionId,
		});
		const redirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: page.transactionId,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected reauthorization redirect.');
		const oauthState = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (oauthState === null) throw new Error('Expected reauthorization OAuth state.');
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'replacement-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: redirect.transactionId,
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected reauthorization confirmation.');
		await service.confirmAccount({
			browserBindingSecret: callback.confirmation.browserBindingSecret,
			completionSessionId: callback.confirmation.completionSessionId,
			csrfToken: callback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		expect(service.validateRuntimeCredentialSnapshot(snapshot)).toEqual({
			kind: 'stale',
			reason: 'credential-changed',
		});
		const replacementGrant = currentCatalog.getGrant(grant.credentialId);
		if (replacementGrant === undefined) throw new Error('Expected replacement OAuth grant.');
		const replacementSnapshot = {
			...snapshot,
			materialRevision: replacementGrant.materialRevision,
		};
		expect(service.validateRuntimeCredentialSnapshot(replacementSnapshot)).toEqual({
			kind: 'current',
		});
		expect(
			currentCatalog.deleteGrantForAccountApplication({
				accountProfileId: replacementGrant.accountProfileId,
				agentId: replacementGrant.agentId,
				applicationId: replacementGrant.applicationId,
				expectedCredentialId: replacementGrant.credentialId,
				expectedRecordRevision: replacementGrant.recordRevision,
				zoneId: replacementGrant.zoneId,
			}),
		).toEqual({ kind: 'deleted' });
		expect(service.validateRuntimeCredentialSnapshot(replacementSnapshot)).toEqual({
			kind: 'stale',
			reason: 'credential-unavailable',
		});
	});

	it('lists configured application and service IDs so agents can form bounded suggestions', async () => {
		// Arrange
		const service = await createService({ oauthConfig: config({ includeWorkspace: true }) });

		// Act
		const listed = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: { actionId: 'oauth_authorization.list' },
		});

		// Assert
		expect(listed).toMatchObject({
			kind: 'authorization-list',
			profiles: [
				{
					accountProfileId: 'personal-google',
					applications: [],
					authorizationOptions: [
						{
							applicationId: 'gmail-app',
							applicationLabel: 'Gmail',
							services: [
								{
									maximumPermission: 'write',
									serviceId: 'gmail',
									serviceLabel: 'Gmail messages',
								},
							],
						},
						{
							applicationId: 'workspace-app',
							applicationLabel: 'Workspace',
							services: [
								{
									maximumPermission: 'read',
									serviceId: 'calendar',
									serviceLabel: 'Calendar',
								},
							],
						},
					],
					kind: 'unbound',
				},
			],
		});
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.begin',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
					suggestedSelections: oauthPermissionSelectionsSchema.parse({
						gmail: { readonly: 'read' },
					}),
				},
			}),
		).toEqual({
			failure: { kind: 'authorization-denied' },
			kind: 'authorization-failed',
		});
	});

	it('stops admission, aborts provider work, and drains before close completes', async () => {
		let resolveExchangeStarted: (() => void) | undefined;
		const exchangeStarted = new Promise<void>((resolve) => {
			resolveExchangeStarted = resolve;
		});
		const baseAdapter = createAdapter();
		const service = await createService({
			adapter: {
				...baseAdapter,
				exchangeAuthorizationCode: async ({ signal }) =>
					await new Promise((resolve) => {
						resolveExchangeStarted?.();
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
			},
		});
		const begun = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		const redirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected Google redirect.');
		const state = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (state === null) throw new Error('Google redirect omitted OAuth state.');
		const callback = service.handleGoogleCallback({
			authorizationCode: 'in-flight-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState: state,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: redirect.transactionId,
		});
		await exchangeStarted;

		service.stopAdmission();
		expect(service.reapExpiredTransactions()).toEqual({
			completionSessionCount: 0,
			transactionCount: 0,
		});
		await expect(service.drain()).resolves.toBeUndefined();
		await expect(service.close()).resolves.toBeUndefined();
		await expect(callback).resolves.toEqual({ kind: 'failed', reason: 'provider-unavailable' });
		await expect(
			service.executeAuthorizationAction({
				agentId: 'hermes',
				request: { actionId: 'oauth_authorization.list' },
			}),
		).rejects.toThrow('admission is closed');
	});

	it('cancels only a browser-bound transaction with matching identity, binding, and CSRF', async () => {
		const service = await createService();
		const begun = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});

		expect(
			service.cancelBrowserTransaction({
				browserBindingSecret: page.browserBindingSecret,
				csrfToken: page.csrfToken,
				tailnetLogin: 'other@example.test',
				transactionId: begun.transactionId,
			}),
		).toBe(false);
		expect(
			service.cancelBrowserTransaction({
				browserBindingSecret: page.browserBindingSecret,
				csrfToken: page.csrfToken,
				tailnetLogin: 'human@example.test',
				transactionId: begun.transactionId,
			}),
		).toBe(true);
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: begun.transactionId,
				},
			}),
		).toEqual({ failure: { kind: 'consumed' }, kind: 'authorization-failed' });

		const restarted = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (restarted.kind !== 'authorization-begun') throw new Error('Expected restarted flow.');
		const restartedPage = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: restarted.transactionId,
		});
		const restartedRedirect = service.submitPermissions({
			browserBindingSecret: restartedPage.browserBindingSecret,
			csrfToken: restartedPage.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: restarted.transactionId,
		});
		if (restartedRedirect.kind !== 'redirect') throw new Error('Expected restarted redirect.');
		expect(
			service.cancelBrowserTransaction({
				browserBindingSecret: restartedPage.browserBindingSecret,
				csrfToken: restartedPage.csrfToken,
				tailnetLogin: 'human@example.test',
				transactionId: restarted.transactionId,
			}),
		).toBe(true);
	});

	it('keeps callback completion owned by the original ceremony and honours agent cancellation', async () => {
		const service = await createService();
		const begun = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		const redirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected Google redirect.');
		const oauthState = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (oauthState === null) throw new Error('Google redirect omitted OAuth state.');
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'completion-cancel-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');

		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.begin',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				},
			}),
		).toEqual({ kind: 'authorization-pending', transactionId: begun.transactionId });
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.cancel',
					transactionId: begun.transactionId,
				},
			}),
		).toEqual({ kind: 'authorization-cancelled' });
		await expect(
			service.confirmAccount({
				browserBindingSecret: callback.confirmation.browserBindingSecret,
				completionSessionId: callback.confirmation.completionSessionId,
				csrfToken: callback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).rejects.toThrow('consumed-or-missing');
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toEqual([]);
	});

	it('reports pending when agent cancellation races a completion commit', async () => {
		// Arrange
		let cancellationResult:
			| ReturnType<GoogleOAuthBrokerService['executeAuthorizationAction']>
			| undefined;
		const raceContext: {
			publicCeremonyId?: OAuthTransactionId;
			service?: GoogleOAuthBrokerService;
		} = {};
		const service = await createService({
			catalogDecorator: (baseCatalog) => ({
				...baseCatalog,
				commitEnrollmentGrant: (enrollment) => {
					if (raceContext.service === undefined || raceContext.publicCeremonyId === undefined) {
						throw new Error('Service race fixture was not initialized.');
					}
					cancellationResult = raceContext.service.executeAuthorizationAction({
						agentId: 'hermes',
						request: {
							actionId: 'oauth_authorization.cancel',
							transactionId: raceContext.publicCeremonyId,
						},
					});
					return baseCatalog.commitEnrollmentGrant(enrollment);
				},
			}),
		});
		raceContext.service = service;
		const begun = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
		raceContext.publicCeremonyId = begun.transactionId;
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		const redirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected Google redirect.');
		const oauthState = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (oauthState === null) throw new Error('Google redirect omitted OAuth state.');
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'completion-cancel-race-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');

		// Act
		const completionResult = await service.confirmAccount({
			browserBindingSecret: callback.confirmation.browserBindingSecret,
			completionSessionId: callback.confirmation.completionSessionId,
			csrfToken: callback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});

		// Assert
		expect(await cancellationResult).toEqual({
			kind: 'authorization-pending',
			transactionId: begun.transactionId,
		});
		expect(completionResult).toEqual({
			accountLabel: 'human@example.test',
			kind: 'completed',
		});
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(1);
	});

	it('releases completion authority immediately when catalog commit fails', async () => {
		const service = await createService({
			catalogDecorator: (baseCatalog) => ({
				...baseCatalog,
				commitEnrollmentGrant: () => {
					throw new Error('forced enrollment commit failure');
				},
			}),
		});
		const begun = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		const redirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected Google redirect.');
		const oauthState = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (oauthState === null) throw new Error('Google redirect omitted OAuth state.');
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'commit-failure-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');

		await expect(
			service.confirmAccount({
				browserBindingSecret: callback.confirmation.browserBindingSecret,
				completionSessionId: callback.confirmation.completionSessionId,
				csrfToken: callback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).rejects.toThrow('forced enrollment commit failure');
		await expect(
			service.confirmAccount({
				browserBindingSecret: callback.confirmation.browserBindingSecret,
				completionSessionId: callback.confirmation.completionSessionId,
				csrfToken: callback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).rejects.toThrow('consumed-or-missing');
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.begin',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				},
			}),
		).toMatchObject({ kind: 'authorization-begun' });
	});

	it('does not clear a newer reauthorization while final completion notification is pending', async () => {
		const notificationStarted = Promise.withResolvers<void>();
		const releaseNotification = Promise.withResolvers<void>();
		const service = await createService({
			onCredentialMaterialChanged: async (): Promise<void> => {
				notificationStarted.resolve();
				await releaseNotification.promise;
			},
		});
		const prepared = await prepareAccountConfirmation({
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			service,
		});
		const confirmationPromise = service.confirmAccount({
			browserBindingSecret: prepared.confirmation.browserBindingSecret,
			completionSessionId: prepared.confirmation.completionSessionId,
			csrfToken: prepared.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		await notificationStarted.promise;

		const reauthorization = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.reauthorize',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			},
		});
		expect(reauthorization).toMatchObject({ kind: 'authorization-begun' });
		releaseNotification.resolve();
		await expect(confirmationPromise).resolves.toMatchObject({ kind: 'completed' });
		if (reauthorization.kind !== 'authorization-begun') {
			throw new Error('Expected reauthorization to begin.');
		}
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: reauthorization.transactionId,
				},
			}),
		).toMatchObject({ kind: 'authorization-pending' });
	});

	it('does not return a successor redirect after that ceremony is concurrently cancelled', async () => {
		const notificationStarted = Promise.withResolvers<void>();
		const releaseNotification = Promise.withResolvers<void>();
		const service = await createService({
			oauthConfig: config({ includeWorkspace: true }),
			onCredentialMaterialChanged: async (): Promise<void> => {
				notificationStarted.resolve();
				await releaseNotification.promise;
			},
		});
		const prepared = await prepareAccountConfirmation({
			selections: oauthPermissionSelectionsSchema.parse({
				'gmail-app': { gmail: 'read' },
				'workspace-app': { calendar: 'read' },
			}),
			service,
		});
		const confirmationPromise = service.confirmAccount({
			browserBindingSecret: prepared.confirmation.browserBindingSecret,
			completionSessionId: prepared.confirmation.completionSessionId,
			csrfToken: prepared.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		await notificationStarted.promise;

		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.cancel',
					transactionId: prepared.publicCeremonyId,
				},
			}),
		).toEqual({ kind: 'authorization-cancelled' });
		releaseNotification.resolve();
		await expect(confirmationPromise).resolves.toEqual({ kind: 'authorization-denied' });
	});
});
