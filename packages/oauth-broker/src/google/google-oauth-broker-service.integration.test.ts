import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { oauthConfigSchema, type OAuthConfig } from '@agent-vm/config-contracts';
import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthServiceIdSchema,
	oauthScopeSchema,
	oauthTokenLifecycleSchema,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
	openOAuthCredentialCatalog,
	type OAuthCredentialCatalog,
} from '../oauth-credential-catalog.js';
import {
	googleWebClientCredentialsSchema,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';
import {
	createGoogleOAuthBrokerService,
	type GoogleOAuthBrokerService,
} from './google-oauth-broker-service.js';

const redirectUri = 'https://auth.claw.askluna.xyz:18900/oauth/google/callback';
const keyEncryptionKey = new Uint8Array(32).fill(81);
const gmailReadScope = oauthScopeSchema.parse('gmail.readonly');
const openIdScope = oauthScopeSchema.parse('openid');
const emailScope = oauthScopeSchema.parse('https://www.googleapis.com/auth/userinfo.email');

let catalog: OAuthCredentialCatalog | undefined;

afterEach(() => {
	catalog?.close();
	catalog = undefined;
});

function applicationConfig(name: string): Record<string, unknown> {
	return {
		clientCredentials: { ref: `op://agent-vm-testing/${name}/client`, source: '1password' },
		clientKind: 'web',
		description: `${name} OAuth application.`,
		label: name,
	};
}

function config(options: { readonly includeWorkspace?: boolean } = {}): OAuthConfig {
	return oauthConfigSchema.parse({
		agents: {
			hermes: {
				accountProfiles: {
					'personal-google': {
						applications: {
							'gmail-app': { maximumPermissions: { gmail: 'write' } },
							...(options.includeWorkspace
								? { 'workspace-app': { maximumPermissions: { calendar: 'read' } } }
								: {}),
						},
						authorizedTailnetLogins: ['human@example.test'],
						provider: 'google',
					},
				},
			},
		},
		browser: {
			listener: {
				certificatePath: '/tmp/oauth-test.crt',
				kind: 'tailscale_https',
				port: 18_900,
				privateKeyPath: '/tmp/oauth-test.key',
			},
			publicBaseUrl: 'https://auth.claw.askluna.xyz:18900',
		},
		providers: {
			google: {
				applications: {
					'gmail-app': {
						...applicationConfig('Gmail'),
						services: {
							gmail: {
								label: 'Gmail messages',
								read: ['gmail.readonly'],
								write: ['gmail.modify'],
							},
						},
					},
					'workspace-app': {
						...applicationConfig('Workspace'),
						services: {
							calendar: { label: 'Calendar', read: ['calendar.readonly'] },
						},
					},
					'youtube-app': {
						...applicationConfig('YouTube'),
						services: {
							youtube: { label: 'YouTube', read: ['youtube.readonly'] },
						},
					},
				},
				kind: 'google',
			},
		},
		schemaVersion: 1,
		storage: {
			keyEncryptionKey: { ref: 'op://agent-vm-testing/oauth-kek/password', source: '1password' },
		},
	});
}

function clientCredentials(): GoogleWebClientCredentials {
	return googleWebClientCredentialsSchema.parse({
		web: {
			auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
			client_id: 'client-id',
			client_secret: 'client-secret',
			redirect_uris: [redirectUri],
			token_uri: 'https://oauth2.googleapis.com/token',
		},
	});
}

function createAdapter(
	props: {
		readonly extraGrantedScope?: string | undefined;
	} = {},
): GoogleOAuthAdapter {
	let requestedScopes: readonly ReturnType<typeof oauthScopeSchema.parse>[] = [];
	return {
		buildAuthorizationUrl: (authorization) => {
			requestedScopes = authorization.requestedScopes;
			const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
			url.searchParams.set('state', authorization.state);
			return url.toString();
		},
		exchangeAuthorizationCode: async (): Promise<{
			authorization: GoogleProviderAuthorization;
			kind: 'authorized';
		}> => ({
			authorization: {
				accessToken: 'provider-access-token-marker',
				accessTokenExpiresAtMs: 10_000_000,
				accountEmail: 'human@example.test',
				accountSubject: 'google-subject-1',
				grantedScopes: [
					...requestedScopes,
					emailScope,
					openIdScope,
					...(props.extraGrantedScope === undefined
						? []
						: [oauthScopeSchema.parse(props.extraGrantedScope)]),
				],
				kind: 'google-provider-authorization',
				refreshToken: 'provider-refresh-token-marker',
			},
			kind: 'authorized',
		}),
		refreshAuthorization: async () => {
			throw new Error('Unexpected refresh during enrollment.');
		},
		revokeAuthorization: async () => ({ kind: 'revoked' }),
		tokenLifecycle: oauthTokenLifecycleSchema.parse({
			kind: 'refreshable',
			refreshMode: 'stable-refresh-token',
		}),
	};
}

async function createService(
	props: {
		readonly adapter?: GoogleOAuthAdapter;
		readonly catalogDecorator?: (catalog: OAuthCredentialCatalog) => OAuthCredentialCatalog;
		readonly oauthConfig?: OAuthConfig;
		readonly now?: () => number;
	} = {},
): Promise<GoogleOAuthBrokerService> {
	const stateRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-oauth-broker-service-'));
	catalog = await openOAuthCredentialCatalog({
		databasePath: path.join(stateRoot, 'zones', 'apollofam', 'oauth', 'credentials.sqlite'),
	});
	const credentials = clientCredentials();
	return createGoogleOAuthBrokerService({
		catalog: props.catalogDecorator?.(catalog) ?? catalog,
		clientCredentialsByApplication: {
			'gmail-app': credentials,
			'workspace-app': credentials,
			'youtube-app': credentials,
		},
		config: props.oauthConfig ?? config(),
		googleAdapter: props.adapter ?? createAdapter(),
		keyEncryptionKey,
		keyEncryptionKeyVersion: 1,
		now: props.now ?? (() => 1_000),
		zoneId: 'apollofam',
	});
}

async function enrollGmailRead(service: GoogleOAuthBrokerService): Promise<void> {
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
		authorizationCode: 'helper-enrollment-code',
		browserBindingSecret: redirect.browserBindingSecret,
		oauthState,
		redirectUri,
		tailnetLogin: 'human@example.test',
		transactionId: redirect.transactionId,
	});
	if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');
	const completed = await service.confirmAccount({
		browserBindingSecret: callback.confirmation.browserBindingSecret,
		completionSessionId: callback.confirmation.completionSessionId,
		csrfToken: callback.confirmation.csrfToken,
		tailnetLogin: 'human@example.test',
	});
	if (completed.kind !== 'completed') throw new Error('Expected completed authorization.');
}

describe('Google OAuth broker service', () => {
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
		await enrollGmailRead(service);

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
		await enrollGmailRead(service);

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

	it('deletes a locally corrupt grant when provider revocation material is unrecoverable', async () => {
		const service = await createService({
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
		await enrollGmailRead(service);

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
