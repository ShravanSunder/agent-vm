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
		revokeAuthorization: async () => {
			throw new Error('Unexpected revocation during enrollment.');
		},
		tokenLifecycle: oauthTokenLifecycleSchema.parse({
			kind: 'refreshable',
			refreshMode: 'stable-refresh-token',
		}),
	};
}

async function createService(
	props: {
		readonly adapter?: GoogleOAuthAdapter;
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
		catalog,
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
		expect(catalog?.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(2);
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
