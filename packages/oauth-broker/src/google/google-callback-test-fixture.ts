import { oauthConfigSchema, type OAuthConfig } from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthTokenLifecycleSchema,
} from '@agent-vm/oauth-broker-contracts';
import { vi, type Mock } from 'vitest';

import { createOAuthConfigTestInput } from '../../../config-contracts/src/oauth-config-test-fixture.js';
import { clientCredentials, owner, wrappingKey } from '../oauth-catalog-test-fixture.js';
import { type OAuthCeremonyTarget } from '../oauth-ceremony-contracts.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import {
	createOAuthTransactionStore,
	type OAuthTransactionStore,
} from '../oauth-transaction-store.js';
import {
	googleProviderAuthorizationSchema,
	type GoogleAuthorizationCodeExchangeResult,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
} from './google-oauth-adapter.js';
import { createGoogleOAuthPermissionPolicy } from './google-oauth-permission-policy.js';
import {
	createGoogleProviderAuthorizationCallback,
	type GoogleProviderAuthorizationCallback,
} from './google-provider-authorization-callback.js';

export const callbackIdentity = { ...owner, sessionId: 'test-session' };
export const callbackApplicationId = oauthApplicationIdSchema.parse('gmail-app');

type CallbackRequest = Parameters<
	GoogleProviderAuthorizationCallback['handleGoogleCallback']
>[0] & { readonly csrfToken: string };
type PrepareRetry = Parameters<
	typeof createGoogleProviderAuthorizationCallback
>[0]['prepareCallbackRetry'];
interface BeginCallbackTestInput {
	readonly agentId?: string;
	readonly target?: OAuthCeremonyTarget;
	readonly configRevision?: string;
}
interface GoogleCallbackTestFixture {
	readonly authorization: GoogleProviderAuthorization;
	readonly begin: (props?: BeginCallbackTestInput) => CallbackRequest;
	readonly buildAuthorizationUrl: Mock<GoogleOAuthAdapter['buildAuthorizationUrl']>;
	readonly callback: GoogleProviderAuthorizationCallback;
	readonly config: OAuthConfig;
	readonly exchangeAuthorizationCode: Mock<GoogleOAuthAdapter['exchangeAuthorizationCode']>;
	readonly prepareCallbackRetry: Mock<PrepareRetry>;
	readonly revokeAuthorization: Mock<GoogleOAuthAdapter['revokeAuthorization']>;
	readonly store: OAuthTransactionStore<GoogleProviderAuthorization>;
	readonly advanceTime: (milliseconds: number) => void;
	readonly stopAdmission: () => void;
}

export function createCallbackTestFixture(
	catalog: OAuthCredentialCatalog,
): GoogleCallbackTestFixture {
	let timeMs = 1_000;
	let admissionOpen = true;
	const configInput = createOAuthConfigTestInput();
	configInput.owners.owner.clerkUserId = owner.userId;
	const config = oauthConfigSchema.parse(configInput);
	const permissionPolicy = createGoogleOAuthPermissionPolicy({
		config,
		offeredGroupIdsByAgentApplication: {
			sun: { 'gmail-app': ['gmail.read', 'gmail.write'] },
			ember: { 'gmail-app': ['gmail.read'] },
		},
	});
	const selections = oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] });
	const scopes = permissionPolicy.scopesForApplication('gmail-app', selections);
	const authorization = googleProviderAuthorizationSchema.parse({
		accessToken: 'synthetic-access',
		accessTokenExpiresAtMs: 1_000_000,
		accountEmail: 'synthetic@example.test',
		accountSubject: 'same-test-google-subject',
		grantedScopes: scopes,
		kind: 'google-provider-authorization',
		refreshToken: 'synthetic-refresh',
	});
	const exchangeAuthorizationCode = vi.fn<GoogleOAuthAdapter['exchangeAuthorizationCode']>(
		async (): Promise<GoogleAuthorizationCodeExchangeResult> => ({
			kind: 'authorized',
			authorization,
		}),
	);
	const buildAuthorizationUrl = vi.fn<GoogleOAuthAdapter['buildAuthorizationUrl']>(
		() => 'https://accounts.google.com/o/oauth2/v2/auth',
	);
	const revokeAuthorization = vi.fn<GoogleOAuthAdapter['revokeAuthorization']>(async () => {
		throw new Error('Callback must never revoke provider authority.');
	});
	const adapter: GoogleOAuthAdapter = {
		buildAuthorizationUrl,
		exchangeAuthorizationCode,
		refreshAuthorization: async () => {
			throw new Error('Callback must not refresh.');
		},
		revokeAuthorization,
		tokenLifecycle: oauthTokenLifecycleSchema.parse({
			kind: 'refreshable',
			refreshMode: 'stable-refresh-token',
		}),
	};
	const store = createOAuthTransactionStore({
		now: () => timeMs,
		providerGrantSchema: googleProviderAuthorizationSchema,
	});
	const prepareCallbackRetry = vi.fn<PrepareRetry>((): never => {
		throw new Error('Unexpected retry in callback identity test.');
	});
	const callback = createGoogleProviderAuthorizationCallback({
		catalog,
		clientCredentialsByApplication: {
			'gmail-app': clientCredentials,
			'workspace-app': clientCredentials,
			'youtube-app': clientCredentials,
		},
		config,
		configRevision: 'test-config',
		googleAdapter: adapter,
		isAdmissionOpen: () => admissionOpen,
		keyEncryptionKey: wrappingKey,
		now: () => timeMs,
		permissionPolicy,
		prepareCallbackRetry,
		providerSignal: new AbortController().signal,
		transactionStore: store,
		zoneId: config.zoneId,
	});
	const begin = (props: BeginCallbackTestInput = {}): CallbackRequest => {
		const agentId = props.agentId ?? 'sun';
		const transaction = store.createTransaction({
			agentId,
			applicationIds: [callbackApplicationId],
			configRevision: props.configRevision ?? 'test-config',
			initiator: { kind: 'agent', agentId },
			target: props.target ?? { kind: 'enroll', applicationId: callbackApplicationId },
		});
		store.bindBrowserIdentity({
			identity: callbackIdentity,
			transactionId: transaction.transactionId,
		});
		const redirectUri = clientCredentials.web.redirect_uris[0];
		if (redirectUri === undefined) throw new Error('Synthetic client requires a redirect URI.');
		const authorizing = store.beginApplicationAuthorization({
			applicationId: callbackApplicationId,
			completedApplications: [],
			confirmedSelections: selections,
			confirmedScopes: scopes,
			redirectUri,
			remainingApplications: [],
			transactionId: transaction.transactionId,
		});
		return {
			identity: callbackIdentity,
			authorizationCode: 'synthetic-code',
			browserBindingSecret: authorizing.browserBindingSecret,
			csrfToken: authorizing.csrfSecret,
			oauthState: authorizing.oauthState,
			redirectUri: authorizing.redirectUri,
			transactionId: transaction.transactionId,
		};
	};
	return {
		authorization,
		begin,
		buildAuthorizationUrl,
		callback,
		config,
		exchangeAuthorizationCode,
		prepareCallbackRetry,
		revokeAuthorization,
		store,
		advanceTime: (milliseconds: number): void => {
			timeMs += milliseconds;
		},
		stopAdmission: (): void => {
			admissionOpen = false;
		},
	};
}
