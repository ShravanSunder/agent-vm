import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { oauthConfigSchema } from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	type OAuthAuthorizationActionResult,
	type OAuthAuthorizationActionRequest,
	type OAuthPermissionSelections,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';

import { createOAuthConfigTestInput } from '../../../config-contracts/src/oauth-config-test-fixture.js';
import { clientCredentials, wrappingKey } from '../oauth-catalog-test-fixture.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import { openOAuthCredentialCatalog } from '../oauth-credential-catalog.js';
import { createGoogleOAuthAdapter, type GoogleOAuthAdapter } from './google-oauth-adapter.js';
import {
	type GoogleOAuthBrokerService,
	type GoogleOAuthRedirectResult,
	type GoogleOAuthCallbackResult,
	type GoogleOAuthConfirmationPageData,
	type GoogleOAuthPermissionPageData,
} from './google-oauth-broker-contracts.js';
import { createGoogleOAuthBrokerService } from './google-oauth-broker-service.js';

export const facadeIdentity = {
	issuer: 'https://identity.example.test',
	userId: 'user_test_owner',
	sessionId: 'test-session',
};
export const facadeApplicationId = oauthApplicationIdSchema.parse('gmail-app');
interface BrokerFacadeFixture {
	readonly broker: GoogleOAuthBrokerService;
	readonly catalog: OAuthCredentialCatalog;
	readonly config: ReturnType<typeof oauthConfigSchema.parse>;
	readonly providerRequests: readonly string[];
	readonly containments: readonly unknown[];
	readonly exchangeRedirect: (
		redirect: GoogleOAuthRedirectResult,
	) => Promise<GoogleOAuthCallbackResult>;
	readonly confirm: (
		confirmation: GoogleOAuthConfirmationPageData,
		alias?: string,
	) => ReturnType<GoogleOAuthBrokerService['confirmAccount']>;
	readonly enroll: (
		agentId?: string,
	) => Promise<Extract<OAuthAuthorizationActionResult, { kind: 'authorization-completed' }>>;
}
export async function createBrokerFacadeFixture(
	options: {
		readonly includeDocuments?: boolean;
		readonly isAdmissionOpen?: () => boolean;
		readonly now?: () => number;
		readonly transformAdapter?: (adapter: GoogleOAuthAdapter) => GoogleOAuthAdapter;
		readonly containAuthorizationMaterial?: Parameters<
			typeof createGoogleOAuthBrokerService
		>[0]['containAuthorizationMaterial'];
	} = {},
): Promise<BrokerFacadeFixture> {
	const directory = await mkdtemp(path.join(tmpdir(), 'oauth-facade-'));
	const catalog = await openOAuthCredentialCatalog({
		databasePath: path.join(directory, 'credentials.sqlite'),
	});
	const config = oauthConfigSchema.parse(createOAuthConfigTestInput());
	const now = options.now ?? (() => 1_000);
	if (options.includeDocuments) {
		const sun = config.agents.sun;
		if (sun === undefined) throw new Error('Expected synthetic Sun agent.');
		sun.applications['workspace-app'] = {
			ceiling: { kind: 'explicit', groupIds: ['drive.all-files.read'] },
		};
	}
	const providerRequests: string[] = [];
	const containments: unknown[] = [];
	const scopesByCode = new Map<string, readonly string[]>();
	const adapter = createGoogleOAuthAdapter({
		now,
		fetchImpl: async (url, requestOptions) => {
			const endpoint = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			providerRequests.push(endpoint);
			if (endpoint === 'https://oauth2.googleapis.com/token') {
				const requestBody = requestOptions?.body;
				if (typeof requestBody !== 'string' && !(requestBody instanceof URLSearchParams))
					throw new Error('Expected synthetic form-encoded token request.');
				const body = new URLSearchParams(requestBody);
				const code = body.get('code') ?? '';
				const scopes = scopesByCode.get(code);
				if (scopes === undefined) throw new Error('Unexpected mock Google code.');
				return Response.json({
					access_token: `synthetic-access-${code}`,
					refresh_token: `synthetic-refresh-${code}`,
					expires_in: 3600,
					token_type: 'Bearer',
					scope: scopes.join(' '),
				});
			}
			if (endpoint === 'https://openidconnect.googleapis.com/v1/userinfo')
				return Response.json({
					email: 'synthetic@example.test',
					email_verified: true,
					sub: 'shared-test-subject',
				});
			throw new Error('Unexpected provider endpoint; no live network allowed.');
		},
	});
	const credentials = {
		web: {
			...clientCredentials.web,
			redirect_uris: [`${config.browser.publicBaseUrl}/oauth/google/callback`],
		},
	};
	const providerAdapter = {
		...adapter,
		buildAuthorizationUrl: (
			request: Parameters<GoogleOAuthAdapter['buildAuthorizationUrl']>[0],
		): string => {
			scopesByCode.set(request.state, request.requestedScopes);
			return adapter.buildAuthorizationUrl(request);
		},
	};
	const broker = createGoogleOAuthBrokerService({
		catalog,
		config,
		configRevision: 'config-1',
		isAdmissionOpen: options.isAdmissionOpen ?? (() => true),
		now,
		clientCredentialsByApplication: {
			'gmail-app': credentials,
			'workspace-app': credentials,
			'youtube-app': credentials,
		},
		clientBindingRevisionsByApplication: {
			'gmail-app': 'client-binding-1',
			'workspace-app': 'client-binding-2',
			'youtube-app': 'client-binding-3',
		},
		allowedHostsByApplication: {
			'gmail-app': ['gmail.googleapis.com'],
			'workspace-app': ['drive.googleapis.com'],
			'youtube-app': ['youtube.googleapis.com'],
		},
		googleAdapter: options.transformAdapter?.(providerAdapter) ?? providerAdapter,
		keyEncryptionKey: wrappingKey,
		keyEncryptionKeyVersion: 1,
		offeredGroupIdsByAgentApplication: {
			sun: {
				'gmail-app': ['gmail.read', 'gmail.write'],
				...(options.includeDocuments ? { 'workspace-app': ['drive.all-files.read'] } : {}),
			},
			ember: { 'gmail-app': ['gmail.read'] },
		},
		operationIdsByAgent: {
			sun: ['gmail.search', 'gmail.send', ...(options.includeDocuments ? ['drive.list'] : [])],
			ember: ['gmail.search'],
		},
		recommendationSelectionsByAgent: {
			sun: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] }),
			ember: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] }),
		},
		readAccountActivity: () => ({
			kind: 'ready',
			disposition: 'allow',
			overrideRevision: 1,
			defaultsRevision: 'defaults-1',
		}),
		containAuthorizationMaterial: async (target) => {
			containments.push(target);
			return options.containAuthorizationMaterial === undefined
				? 'contained'
				: await options.containAuthorizationMaterial(target);
		},
	});
	const exchangeRedirect = (
		redirect: GoogleOAuthRedirectResult,
	): Promise<GoogleOAuthCallbackResult> => {
		const state = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (state === null) throw new Error('Expected OAuth state.');
		return broker.handleGoogleCallback({
			identity: facadeIdentity,
			transactionId: redirect.transactionId,
			browserBindingSecret: redirect.browserBindingSecret,
			authorizationCode: state,
			oauthState: state,
			redirectUri: credentials.web.redirect_uris[0] ?? '',
		});
	};
	const confirm = (
		confirmation: GoogleOAuthConfirmationPageData,
		alias = 'My mailbox',
	): ReturnType<GoogleOAuthBrokerService['confirmAccount']> =>
		broker.confirmAccount({
			identity: facadeIdentity,
			completionSessionId: confirmation.completionSessionId,
			browserBindingSecret: confirmation.browserBindingSecret,
			csrfToken: confirmation.csrfToken,
			accountAlias: alias,
		});
	const enroll = async (
		agentId = 'sun',
	): Promise<Extract<OAuthAuthorizationActionResult, { kind: 'authorization-completed' }>> => {
		const begun = await broker.executeAuthorizationAction({
			agentId,
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected enrollment link.');
		const page = broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
		const redirect = broker.submitPermissions({
			identity: facadeIdentity,
			transactionId: page.transactionId,
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] }),
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected Google consent.');
		const state = new URL(redirect.authorizationUrl).searchParams.get('state');
		if (state === null) throw new Error('Expected OAuth state.');
		const callback = await broker.handleGoogleCallback({
			identity: facadeIdentity,
			transactionId: redirect.transactionId,
			browserBindingSecret: redirect.browserBindingSecret,
			authorizationCode: state,
			oauthState: state,
			redirectUri: credentials.web.redirect_uris[0] ?? '',
		});
		if (callback.kind !== 'confirmation') throw new Error('Expected account confirmation.');
		const completed = await broker.confirmAccount({
			identity: facadeIdentity,
			completionSessionId: callback.confirmation.completionSessionId,
			browserBindingSecret: callback.confirmation.browserBindingSecret,
			csrfToken: callback.confirmation.csrfToken,
			accountAlias: `${agentId} mailbox`,
		});
		if (completed.kind !== 'completed') throw new Error('Expected completed authorization.');
		const status = await broker.executeAuthorizationAction({
			agentId,
			request: { actionId: 'oauth_authorization.status', transactionId: begun.transactionId },
		});
		if (status.kind !== 'authorization-completed')
			throw new Error('Expected public completed status.');
		return status;
	};
	return {
		broker,
		catalog,
		config,
		providerRequests,
		containments,
		enroll,
		exchangeRedirect,
		confirm,
	};
}

export async function prepareBrokerConsent(
	fixture: BrokerFacadeFixture,
	request: Extract<
		OAuthAuthorizationActionRequest,
		{ actionId: 'oauth_authorization.begin' | 'oauth_authorization.reauthorize' }
	> = { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
	selections: OAuthPermissionSelections = oauthPermissionSelectionsSchema.parse({
		'gmail-app': ['gmail.read'],
	}),
): Promise<{
	readonly publicCeremonyId: OAuthTransactionId;
	readonly page: GoogleOAuthPermissionPageData;
	readonly redirect: GoogleOAuthRedirectResult;
}> {
	const begun = await fixture.broker.executeAuthorizationAction({ agentId: 'sun', request });
	if (begun.kind !== 'authorization-begun') throw new Error('Expected consent ceremony.');
	const page = fixture.broker.getPermissionPage({
		identity: facadeIdentity,
		transactionId: begun.transactionId,
	});
	const redirect = fixture.broker.submitPermissions({
		identity: facadeIdentity,
		transactionId: page.transactionId,
		browserBindingSecret: page.browserBindingSecret,
		csrfToken: page.csrfToken,
		selections,
	});
	if (redirect.kind !== 'redirect') throw new Error('Expected provider consent.');
	return { publicCeremonyId: begun.transactionId, page, redirect };
}
