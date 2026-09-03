import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { oauthConfigSchema, type OAuthConfig } from '@agent-vm/config-contracts';
import {
	oauthAccountProfileIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	oauthTokenLifecycleSchema,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach } from 'vitest';

import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import { openOAuthCredentialCatalog } from '../oauth-credential-catalog.js';
import {
	googleWebClientCredentialsSchema,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';
import { type GoogleOAuthBrokerService } from './google-oauth-broker-contracts.js';
import { createGoogleOAuthBrokerService } from './google-oauth-broker-service.js';

export const redirectUri = 'https://auth.claw.askluna.xyz:18900/oauth/google/callback';
export const keyEncryptionKey = new Uint8Array(32).fill(81);
export const gmailReadScope = oauthScopeSchema.parse('gmail.readonly');
export const openIdScope = oauthScopeSchema.parse('openid');
export const emailScope = oauthScopeSchema.parse('https://www.googleapis.com/auth/userinfo.email');

export let catalog: OAuthCredentialCatalog | undefined;

afterEach(() => {
	catalog?.close();
	catalog = undefined;
});

export function applicationConfig(name: string): Record<string, unknown> {
	return {
		clientCredentials: { ref: `op://agent-vm-testing/${name}/client`, source: '1password' },
		clientKind: 'web',
		description: `${name} OAuth application.`,
		label: name,
	};
}

export function config(
	options: {
		readonly gmailReadScope?: string;
		readonly includeWorkspace?: boolean;
	} = {},
): OAuthConfig {
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
								read: [options.gmailReadScope ?? 'gmail.readonly'],
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

export function clientCredentials(): GoogleWebClientCredentials {
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

export function createAdapter(
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

export async function createService(
	props: {
		readonly adapter?: GoogleOAuthAdapter;
		readonly catalog?: OAuthCredentialCatalog;
		readonly catalogDecorator?: (catalog: OAuthCredentialCatalog) => OAuthCredentialCatalog;
		readonly oauthConfig?: OAuthConfig;
		readonly now?: () => number;
		readonly onCredentialMaterialChanged?:
			| ((props: { readonly agentId: string; readonly zoneId: string }) => Promise<void>)
			| undefined;
	} = {},
): Promise<GoogleOAuthBrokerService> {
	const stateRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-oauth-broker-service-'));
	catalog =
		props.catalog ??
		(await openOAuthCredentialCatalog({
			databasePath: path.join(stateRoot, 'zones', 'apollofam', 'oauth', 'credentials.sqlite'),
		}));
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
		...(props.onCredentialMaterialChanged === undefined
			? {}
			: { onCredentialMaterialChanged: props.onCredentialMaterialChanged }),
		zoneId: 'apollofam',
	});
}

export async function enrollGmail(
	service: GoogleOAuthBrokerService,
	permission: 'read' | 'write' = 'read',
): Promise<void> {
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
		selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': { gmail: permission } }),
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
