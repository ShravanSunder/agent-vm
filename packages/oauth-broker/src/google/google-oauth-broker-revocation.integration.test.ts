import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	catalog,
	createAdapter,
	createService,
	enrollGmail,
	redirectUri,
} from './google-oauth-broker-test-fixture.js';

describe('Google OAuth broker revocation and containment', () => {
	it('deletes an already-invalid provider grant during approval-gated revocation', async () => {
		const baseAdapter = createAdapter();
		const service = await createService({
			adapter: {
				...baseAdapter,
				revokeAuthorization: async () => ({
					failure: { kind: 'provider-rejected', providerError: 'invalid_token' },
					kind: 'failed',
				}),
			},
		});
		await enrollGmail(service);

		await expect(
			service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.revoke',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				},
			}),
		).resolves.toEqual({ kind: 'authorization-revoked' });
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toEqual([]);
	});

	it('preserves a concurrently reauthorized grant when an older revocation completes', async () => {
		const revocationStarted = Promise.withResolvers<void>();
		const revocationCompletion = Promise.withResolvers<void>();
		const service = await createService({
			adapter: {
				...createAdapter(),
				revokeAuthorization: async () => {
					revocationStarted.resolve();
					await revocationCompletion.promise;
					return { kind: 'revoked' };
				},
			},
		});
		await enrollGmail(service);
		const initialGrant = catalog?.getGrantForAccountApplication({
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			agentId: 'hermes',
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			zoneId: 'apollofam',
		});
		if (initialGrant === undefined) throw new Error('Expected initial grant.');

		const revocation = service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.revoke',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			},
		});
		await revocationStarted.promise;

		const reauthorization = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.reauthorize',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			},
		});
		if (reauthorization.kind !== 'authorization-begun') {
			throw new Error('Expected concurrent reauthorization.');
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
			transactionId: reauthorization.transactionId,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected reauthorization redirect.');
		const oauthState = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (oauthState === null) throw new Error('Reauthorization omitted OAuth state.');
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'concurrent-reauthorization-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: redirect.transactionId,
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected reauthorization confirmation.');
		await expect(
			service.confirmAccount({
				browserBindingSecret: callback.confirmation.browserBindingSecret,
				completionSessionId: callback.confirmation.completionSessionId,
				csrfToken: callback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).resolves.toEqual({ accountLabel: 'human@example.test', kind: 'completed' });
		const replacementGrant = catalog?.getGrantForAccountApplication({
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			agentId: 'hermes',
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			zoneId: 'apollofam',
		});
		if (replacementGrant === undefined) throw new Error('Expected replacement grant.');
		expect(replacementGrant.recordRevision).toBeGreaterThan(initialGrant.recordRevision);

		revocationCompletion.resolve();
		await expect(revocation).resolves.toEqual({
			failure: { kind: 'unavailable' },
			kind: 'authorization-failed',
		});
		expect(
			catalog?.getGrantForAccountApplication({
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				agentId: 'hermes',
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				zoneId: 'apollofam',
			}),
		).toEqual(replacementGrant);
	});

	it('retains a grant when provider revocation is transiently unavailable', async () => {
		const baseAdapter = createAdapter();
		const service = await createService({
			adapter: {
				...baseAdapter,
				revokeAuthorization: async () => ({
					failure: { kind: 'provider-unavailable', retryable: true },
					kind: 'failed',
				}),
			},
		});
		await enrollGmail(service);

		await expect(
			service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.revoke',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				},
			}),
		).resolves.toEqual({ failure: { kind: 'unavailable' }, kind: 'authorization-failed' });
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(1);
	});

	it('retains and marks a corrupt grant when provider revocation cannot be proven', async () => {
		const revokeAuthorization = vi.fn(async () => ({ kind: 'revoked' as const }));
		const service = await createService({
			adapter: { ...createAdapter(), revokeAuthorization },
			catalogDecorator: (baseCatalog) => ({
				...baseCatalog,
				getGrantForAccountApplication: (query) => {
					const grant = baseCatalog.getGrantForAccountApplication(query);
					return grant === undefined
						? undefined
						: {
								...grant,
								envelope: {
									...grant.envelope,
									payloadCiphertext: `${grant.envelope.payloadCiphertext.startsWith('A') ? 'B' : 'A'}${grant.envelope.payloadCiphertext.slice(1)}`,
								},
							};
				},
			}),
		});
		await enrollGmail(service);

		await expect(
			service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.revoke',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				},
			}),
		).resolves.toEqual({ failure: { kind: 'unavailable' }, kind: 'authorization-failed' });
		expect(revokeAuthorization).not.toHaveBeenCalled();
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toEqual([
			expect.objectContaining({
				lifecycleKind: 'reauthorization-required',
				reauthorizationReason: 'credential-corrupt',
			}),
		]);
	});

	it('does not report enrollment completion when runtime containment is owner-unsafe', async () => {
		const invalidationStarted = Promise.withResolvers<void>();
		const invalidationCompletion = Promise.withResolvers<void>();
		const service = await createService({
			onCredentialMaterialChanged: async () => {
				invalidationStarted.resolve();
				await invalidationCompletion.promise;
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
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'owner-unsafe-enrollment-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: redirect.transactionId,
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');

		const accountConfirmation = service.confirmAccount({
			browserBindingSecret: callback.confirmation.browserBindingSecret,
			completionSessionId: callback.confirmation.completionSessionId,
			csrfToken: callback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		await invalidationStarted.promise;
		const statusWhileInvalidationIsPending = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.status',
				transactionId: begun.transactionId,
			},
		});
		expect(statusWhileInvalidationIsPending).not.toMatchObject({ kind: 'authorization-completed' });

		invalidationCompletion.reject(new Error('owner-unsafe containment'));
		await expect(accountConfirmation).rejects.toThrow(/owner-unsafe containment/u);
		await expect(
			service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: begun.transactionId,
				},
			}),
		).resolves.toEqual({ failure: { kind: 'unavailable' }, kind: 'authorization-failed' });
	});

	it('does not report revocation when runtime containment is owner-unsafe', async () => {
		let rejectInvalidation = false;
		const service = await createService({
			onCredentialMaterialChanged: async () => {
				if (rejectInvalidation) throw new Error('owner-unsafe containment');
			},
		});
		await enrollGmail(service);
		rejectInvalidation = true;

		await expect(
			service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.revoke',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				},
			}),
		).rejects.toThrow(/owner-unsafe containment/u);
	});

	it('rejects provider-granted scope expansion before completion state exists', async () => {
		const service = await createService({
			adapter: createAdapter({ extraGrantedScope: 'drive' }),
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
		expect(
			await service.handleGoogleCallback({
				authorizationCode: 'single-use-code',
				browserBindingSecret: redirect.browserBindingSecret,
				oauthState: state,
				redirectUri,
				tailnetLogin: 'human@example.test',
				transactionId: redirect.transactionId,
			}),
		).toEqual({ kind: 'failed', reason: 'scope-insufficient' });
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toEqual([]);
	}, 30_000);
});
