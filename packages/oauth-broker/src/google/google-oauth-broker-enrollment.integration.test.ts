import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	oauthServiceIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import {
	catalog,
	config,
	createAdapter,
	createService,
	gmailReadScope,
	redirectUri,
} from './google-oauth-broker-test-fixture.js';

describe('Google OAuth broker enrollment ceremonies', () => {
	it('runs a tailnet-bound enrollment and commits one encrypted grant', async () => {
		const service = await createService();
		expect(
			service.resolveToolAvailability({
				agentId: 'hermes',
				requirement: {
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
					kind: 'oauth-account-profile',
					minimumPermission: 'read',
					serviceId: oauthServiceIdSchema.parse('gmail'),
				},
			}),
		).toEqual({ kind: 'authorization-required' });
		const begun = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				suggestedSelections: oauthPermissionSelectionsSchema.parse({
					'gmail-app': { gmail: 'read' },
				}),
			},
		});
		expect(begun.kind).toBe('authorization-begun');
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begun authorization.');
		expect(() =>
			service.getPermissionPage({
				tailnetLogin: 'other@example.test',
				transactionId: begun.transactionId,
			}),
		).toThrow('Tailnet identity');
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		expect(page.applications[0]).toMatchObject({ label: 'Gmail' });
		const redirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		expect(redirect.kind).toBe('redirect');
		if (redirect.kind !== 'redirect') throw new Error('Expected Google redirect.');
		const state = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (state === null) throw new Error('Google redirect omitted OAuth state.');
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'single-use-code',
			browserBindingSecret: redirect.browserBindingSecret,
			oauthState: state,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: redirect.transactionId,
		});
		expect(callback.kind).toBe('confirmation');
		if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');
		const completed = await service.confirmAccount({
			browserBindingSecret: callback.confirmation.browserBindingSecret,
			completionSessionId: callback.confirmation.completionSessionId,
			csrfToken: callback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		expect(completed).toEqual({ accountLabel: 'human@example.test', kind: 'completed' });
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: begun.transactionId,
				},
			}),
		).toMatchObject({
			accountLabel: 'human@example.test',
			accountProfileId: 'personal-google',
			applicationId: 'gmail-app',
			kind: 'authorization-completed',
		});

		const listed = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: { actionId: 'oauth_authorization.list' },
		});
		expect(listed).toMatchObject({
			kind: 'authorization-list',
			profiles: [
				{
					accountLabel: 'human@example.test',
					accountProfileId: 'personal-google',
					applications: [
						{ applicationId: 'gmail-app', grantedScopes: expect.arrayContaining([gmailReadScope]) },
					],
					kind: 'enrolled',
				},
			],
		});
		expect(JSON.stringify(listed)).not.toContain('provider-access-token-marker');
		expect(JSON.stringify(listed)).not.toContain('provider-refresh-token-marker');
		expect(
			service.resolveToolAvailability({
				agentId: 'hermes',
				requirement: {
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
					kind: 'oauth-account-profile',
					minimumPermission: 'read',
					serviceId: oauthServiceIdSchema.parse('gmail'),
				},
			}),
		).toEqual({
			accountProfiles: [
				{ accountLabel: 'human@example.test', accountProfileId: 'personal-google' },
			],
			kind: 'ready',
		});
		expect(
			service.resolveToolAvailability({
				agentId: 'hermes',
				requirement: {
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
					kind: 'oauth-account-profile',
					minimumPermission: 'write',
					serviceId: oauthServiceIdSchema.parse('gmail'),
				},
			}),
		).toEqual({ kind: 'scope-insufficient' });

		const runtimeCredential = await service.resolveRuntimeCredential({
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			agentId: 'hermes',
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			minimumPermission: 'read',
			serviceId: 'gmail',
		});
		expect(runtimeCredential).toMatchObject({
			allowedHosts: ['gmail.googleapis.com'],
			kind: 'ready',
		});
		if (runtimeCredential.kind !== 'ready') throw new Error('Expected runtime credential.');
		expect(new TextDecoder().decode(runtimeCredential.accessToken)).toBe(
			'provider-access-token-marker',
		);
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.begin',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				},
			}),
		).toEqual({ failure: { kind: 'authorization-denied' }, kind: 'authorization-failed' });
		const reauthorization = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.reauthorize',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			},
		});
		if (reauthorization.kind !== 'authorization-begun') {
			throw new Error('Expected approved reauthorization to begin.');
		}
		const reauthorizationPage = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: reauthorization.transactionId,
		});
		const reauthorizationRedirect = service.submitPermissions({
			browserBindingSecret: reauthorizationPage.browserBindingSecret,
			csrfToken: reauthorizationPage.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({
				'gmail-app': { gmail: 'read' },
			}),
			tailnetLogin: 'human@example.test',
			transactionId: reauthorization.transactionId,
		});
		if (reauthorizationRedirect.kind !== 'redirect') {
			throw new Error('Expected approved reauthorization redirect.');
		}
		const reauthorizationState = new URL(reauthorizationRedirect.authorizationUrl).searchParams.get(
			'state',
		);
		if (reauthorizationState === null) {
			throw new Error('Reauthorization redirect omitted OAuth state.');
		}
		const reauthorizationCallback = await service.handleGoogleCallback({
			authorizationCode: 'reauthorization-code',
			browserBindingSecret: reauthorizationRedirect.browserBindingSecret,
			oauthState: reauthorizationState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: reauthorization.transactionId,
		});
		if (reauthorizationCallback.kind !== 'confirmation') {
			throw new Error('Expected reauthorization account confirmation.');
		}
		expect(
			await service.confirmAccount({
				browserBindingSecret: reauthorizationCallback.confirmation.browserBindingSecret,
				completionSessionId: reauthorizationCallback.confirmation.completionSessionId,
				csrfToken: reauthorizationCallback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).toEqual({ accountLabel: 'human@example.test', kind: 'completed' });
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.revoke',
					accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
					applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				},
			}),
		).toEqual({ kind: 'authorization-revoked' });
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: { actionId: 'oauth_authorization.list' },
			}),
		).toMatchObject({
			profiles: [
				{
					accountLabel: 'human@example.test',
					accountProfileId: 'personal-google',
					applications: [],
					kind: 'partially-enrolled',
				},
			],
		});
	});

	it('rejects reauthorization that would downgrade an existing grant before revocation', async () => {
		const service = await createService();
		const initial = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (initial.kind !== 'authorization-begun') throw new Error('Expected initial enrollment.');
		const initialPage = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: initial.transactionId,
		});
		const initialRedirect = service.submitPermissions({
			browserBindingSecret: initialPage.browserBindingSecret,
			csrfToken: initialPage.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'write' } }),
			tailnetLogin: 'human@example.test',
			transactionId: initial.transactionId,
		});
		if (initialRedirect.kind !== 'redirect') throw new Error('Expected initial redirect.');
		const initialState = new URL(initialRedirect.authorizationUrl).searchParams.get('state');
		if (initialState === null) throw new Error('Initial redirect omitted OAuth state.');
		const initialCallback = await service.handleGoogleCallback({
			authorizationCode: 'initial-write-code',
			browserBindingSecret: initialRedirect.browserBindingSecret,
			oauthState: initialState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: initial.transactionId,
		});
		if (initialCallback.kind !== 'confirmation') throw new Error('Expected initial confirmation.');
		expect(initialCallback.confirmation.grantedPermissionLabels).toContain('Gmail messages');
		await service.confirmAccount({
			browserBindingSecret: initialCallback.confirmation.browserBindingSecret,
			completionSessionId: initialCallback.confirmation.completionSessionId,
			csrfToken: initialCallback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		expect(
			await service.resolveRuntimeCredential({
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				agentId: 'hermes',
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				minimumPermission: 'read',
				serviceId: 'gmail',
			}),
		).toMatchObject({ kind: 'ready' });

		const reauthorization = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.reauthorize',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			},
		});
		if (reauthorization.kind !== 'authorization-begun') {
			throw new Error('Expected reauthorization.');
		}
		const reauthorizationPage = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: reauthorization.transactionId,
		});
		const reauthorizationRedirect = service.submitPermissions({
			browserBindingSecret: reauthorizationPage.browserBindingSecret,
			csrfToken: reauthorizationPage.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: 'read' } }),
			tailnetLogin: 'human@example.test',
			transactionId: reauthorization.transactionId,
		});
		if (reauthorizationRedirect.kind !== 'redirect') {
			throw new Error('Expected reauthorization redirect.');
		}
		const reauthorizationState = new URL(reauthorizationRedirect.authorizationUrl).searchParams.get(
			'state',
		);
		if (reauthorizationState === null) throw new Error('Reauthorization omitted OAuth state.');
		const reauthorizationCallback = await service.handleGoogleCallback({
			authorizationCode: 'downgrade-code',
			browserBindingSecret: reauthorizationRedirect.browserBindingSecret,
			oauthState: reauthorizationState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: reauthorization.transactionId,
		});
		if (reauthorizationCallback.kind !== 'confirmation') {
			throw new Error('Expected downgrade confirmation.');
		}
		expect(
			await service.confirmAccount({
				browserBindingSecret: reauthorizationCallback.confirmation.browserBindingSecret,
				completionSessionId: reauthorizationCallback.confirmation.completionSessionId,
				csrfToken: reauthorizationCallback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).toEqual({ kind: 'authorization-denied' });
		expect(
			catalog?.getGrantForAccountApplication({
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
				agentId: 'hermes',
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
				zoneId: 'apollofam',
			})?.grantedScopes,
		).toContain(oauthScopeSchema.parse('gmail.modify'));
	});

	it('continues one browser ceremony across two configured applications', async () => {
		const service = await createService({ oauthConfig: config({ includeWorkspace: true }) });
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
		const firstRedirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({
				'gmail-app': { gmail: 'read' },
				'workspace-app': { calendar: 'read' },
			}),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (firstRedirect.kind !== 'redirect') throw new Error('Expected first Google redirect.');
		const firstState = new URL(firstRedirect.authorizationUrl).searchParams.get('state');
		if (firstState === null) throw new Error('First Google redirect omitted OAuth state.');
		const firstCallback = await service.handleGoogleCallback({
			authorizationCode: 'gmail-code',
			browserBindingSecret: firstRedirect.browserBindingSecret,
			oauthState: firstState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: firstRedirect.transactionId,
		});
		if (firstCallback.kind !== 'confirmation') throw new Error('Expected first confirmation.');
		const secondRedirect = await service.confirmAccount({
			browserBindingSecret: firstCallback.confirmation.browserBindingSecret,
			completionSessionId: firstCallback.confirmation.completionSessionId,
			csrfToken: firstCallback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		expect(secondRedirect.kind).toBe('redirect');
		if (secondRedirect.kind !== 'redirect') throw new Error('Expected second Google redirect.');
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: begun.transactionId,
				},
			}),
		).toEqual({ kind: 'authorization-pending', transactionId: begun.transactionId });
		expect(secondRedirect.applications).toEqual([
			{ applicationId: 'gmail-app', label: 'Gmail', status: 'completed' },
			{ applicationId: 'workspace-app', label: 'Workspace', status: 'authorizing' },
		]);
		const secondState = new URL(secondRedirect.authorizationUrl).searchParams.get('state');
		if (secondState === null) throw new Error('Second Google redirect omitted OAuth state.');
		const secondCallback = await service.handleGoogleCallback({
			authorizationCode: 'workspace-code',
			browserBindingSecret: secondRedirect.browserBindingSecret,
			oauthState: secondState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: secondRedirect.transactionId,
		});
		if (secondCallback.kind !== 'confirmation') throw new Error('Expected second confirmation.');
		await expect(
			service.confirmAccount({
				browserBindingSecret: secondCallback.confirmation.browserBindingSecret,
				completionSessionId: secondCallback.confirmation.completionSessionId,
				csrfToken: secondCallback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).resolves.toEqual({ accountLabel: 'human@example.test', kind: 'completed' });
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: begun.transactionId,
				},
			}),
		).toMatchObject({ kind: 'authorization-completed' });
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(2);
	});

	it('reports a failed ceremony when the next application cannot start after a durable commit', async () => {
		// Arrange
		const baseAdapter = createAdapter();
		let authorizationUrlCount = 0;
		const service = await createService({
			adapter: {
				...baseAdapter,
				buildAuthorizationUrl: (authorization) => {
					authorizationUrlCount += 1;
					if (authorizationUrlCount === 2) {
						throw new Error('forced next-application startup failure');
					}
					return baseAdapter.buildAuthorizationUrl(authorization);
				},
			},
			oauthConfig: config({ includeWorkspace: true }),
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
		const firstRedirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({
				'gmail-app': { gmail: 'read' },
				'workspace-app': { calendar: 'read' },
			}),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (firstRedirect.kind !== 'redirect') throw new Error('Expected first redirect.');
		const firstState = new URL(firstRedirect.authorizationUrl).searchParams.get('state');
		if (firstState === null) throw new Error('First redirect omitted OAuth state.');
		const callback = await service.handleGoogleCallback({
			authorizationCode: 'gmail-code',
			browserBindingSecret: firstRedirect.browserBindingSecret,
			oauthState: firstState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: firstRedirect.transactionId,
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');

		// Act
		await expect(
			service.confirmAccount({
				browserBindingSecret: callback.confirmation.browserBindingSecret,
				completionSessionId: callback.confirmation.completionSessionId,
				csrfToken: callback.confirmation.csrfToken,
				tailnetLogin: 'human@example.test',
			}),
		).rejects.toThrow('forced next-application startup failure');

		// Assert
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: begun.transactionId,
				},
			}),
		).toEqual({ failure: { kind: 'unavailable' }, kind: 'authorization-failed' });
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(1);
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

	it('cancels a later application through the public ceremony identity returned by begin', async () => {
		const service = await createService({ oauthConfig: config({ includeWorkspace: true }) });
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
		const firstRedirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({
				'gmail-app': { gmail: 'read' },
				'workspace-app': { calendar: 'read' },
			}),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (firstRedirect.kind !== 'redirect') throw new Error('Expected first redirect.');
		const firstState = new URL(firstRedirect.authorizationUrl).searchParams.get('state');
		if (firstState === null) throw new Error('First redirect omitted OAuth state.');
		const firstCallback = await service.handleGoogleCallback({
			authorizationCode: 'gmail-cancel-chain-code',
			browserBindingSecret: firstRedirect.browserBindingSecret,
			oauthState: firstState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: firstRedirect.transactionId,
		});
		if (firstCallback.kind !== 'confirmation') throw new Error('Expected first confirmation.');
		const secondRedirect = await service.confirmAccount({
			browserBindingSecret: firstCallback.confirmation.browserBindingSecret,
			completionSessionId: firstCallback.confirmation.completionSessionId,
			csrfToken: firstCallback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		if (secondRedirect.kind !== 'redirect') throw new Error('Expected second redirect.');
		const secondState = new URL(secondRedirect.authorizationUrl).searchParams.get('state');
		if (secondState === null) throw new Error('Second redirect omitted OAuth state.');

		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.cancel',
					transactionId: begun.transactionId,
				},
			}),
		).toEqual({ kind: 'authorization-cancelled' });
		expect(
			await service.handleGoogleCallback({
				authorizationCode: 'workspace-after-cancel-code',
				browserBindingSecret: secondRedirect.browserBindingSecret,
				oauthState: secondState,
				redirectUri,
				tailnetLogin: 'human@example.test',
				transactionId: secondRedirect.transactionId,
			}),
		).toEqual({ kind: 'failed', reason: 'browser-binding-mismatch' });
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(1);
	});

	it('preserves completed grants and creates a bound retry after a later application fails', async () => {
		// Arrange
		const baseAdapter = createAdapter();
		let exchangeCount = 0;
		const service = await createService({
			adapter: {
				...baseAdapter,
				exchangeAuthorizationCode: async (exchangeProps) => {
					exchangeCount += 1;
					return exchangeCount === 2
						? {
								failure: { kind: 'provider-unavailable' as const, retryable: true as const },
								kind: 'failed' as const,
							}
						: await baseAdapter.exchangeAuthorizationCode(exchangeProps);
				},
			},
			oauthConfig: config({ includeWorkspace: true }),
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
		const firstRedirect = service.submitPermissions({
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({
				'gmail-app': { gmail: 'read' },
				'workspace-app': { calendar: 'read' },
			}),
			tailnetLogin: 'human@example.test',
			transactionId: begun.transactionId,
		});
		if (firstRedirect.kind !== 'redirect') throw new Error('Expected first redirect.');
		const firstState = new URL(firstRedirect.authorizationUrl).searchParams.get('state');
		if (firstState === null) throw new Error('First redirect omitted state.');
		const firstCallback = await service.handleGoogleCallback({
			authorizationCode: 'gmail-code',
			browserBindingSecret: firstRedirect.browserBindingSecret,
			oauthState: firstState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: firstRedirect.transactionId,
		});
		if (firstCallback.kind !== 'confirmation') throw new Error('Expected first confirmation.');
		const secondRedirect = await service.confirmAccount({
			browserBindingSecret: firstCallback.confirmation.browserBindingSecret,
			completionSessionId: firstCallback.confirmation.completionSessionId,
			csrfToken: firstCallback.confirmation.csrfToken,
			tailnetLogin: 'human@example.test',
		});
		if (secondRedirect.kind !== 'redirect') throw new Error('Expected second redirect.');
		const secondState = new URL(secondRedirect.authorizationUrl).searchParams.get('state');
		if (secondState === null) throw new Error('Second redirect omitted state.');

		// Act
		const partial = await service.handleGoogleCallback({
			authorizationCode: 'workspace-code',
			browserBindingSecret: secondRedirect.browserBindingSecret,
			oauthState: secondState,
			redirectUri,
			tailnetLogin: 'human@example.test',
			transactionId: secondRedirect.transactionId,
		});

		// Assert
		expect(partial).toMatchObject({
			completed: ['Gmail'],
			kind: 'partial-completion',
			retry: { kind: 'redirect' },
			retryable: ['Workspace'],
		});
		if (partial.kind !== 'partial-completion') {
			throw new Error('Expected partial completion.');
		}
		expect(() =>
			service.retryApplication({
				browserBindingSecret: partial.retry.browserBindingSecret,
				csrfToken: partial.retryCsrfToken,
				tailnetLogin: 'other@example.test',
				transactionId: partial.retry.transactionId,
			}),
		).toThrow('retry authority is invalid');
		expect(
			service.retryApplication({
				browserBindingSecret: partial.retry.browserBindingSecret,
				csrfToken: partial.retryCsrfToken,
				tailnetLogin: 'human@example.test',
				transactionId: partial.retry.transactionId,
			}),
		).toMatchObject({
			authorizationUrl: partial.retry.authorizationUrl,
			kind: 'redirect',
			transactionId: partial.retry.transactionId,
		});
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(1);
	});

	it('replaces an expired begin transaction instead of returning a dead URL', async () => {
		let currentTimeMs = 1_000;
		const service = await createService({ now: () => currentTimeMs });
		const first = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (first.kind !== 'authorization-begun') throw new Error('Expected first authorization.');
		currentTimeMs += 11 * 60_000;
		const second = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		expect(second.kind).toBe('authorization-begun');
		if (second.kind !== 'authorization-begun')
			throw new Error('Expected replacement authorization.');
		expect(second.transactionId).not.toBe(first.transactionId);
	});

	it('clears the public ceremony identity when the human selects no applications', async () => {
		const service = await createService();
		const first = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (first.kind !== 'authorization-begun') throw new Error('Expected first authorization.');
		const page = service.getPermissionPage({
			tailnetLogin: 'human@example.test',
			transactionId: first.transactionId,
		});
		expect(
			service.submitPermissions({
				browserBindingSecret: page.browserBindingSecret,
				csrfToken: page.csrfToken,
				selections: oauthPermissionSelectionsSchema.parse({
					'gmail-app': { gmail: 'none' },
				}),
				tailnetLogin: 'human@example.test',
				transactionId: first.transactionId,
			}),
		).toEqual({ kind: 'already-satisfied' });

		const second = await service.executeAuthorizationAction({
			agentId: 'hermes',
			request: {
				actionId: 'oauth_authorization.begin',
				accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			},
		});
		if (second.kind !== 'authorization-begun') throw new Error('Expected second authorization.');
		expect(second.transactionId).not.toBe(first.transactionId);
		expect(
			await service.executeAuthorizationAction({
				agentId: 'hermes',
				request: {
					actionId: 'oauth_authorization.status',
					transactionId: first.transactionId,
				},
			}),
		).toEqual({ failure: { kind: 'consumed' }, kind: 'authorization-failed' });
	});
});
