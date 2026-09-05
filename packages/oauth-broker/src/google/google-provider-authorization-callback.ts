import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';

import { oauthBrowserSecretsEqual } from '../oauth-browser-security.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import {
	type OAuthCeremonyTransaction,
	type OAuthTransactionStore,
} from '../oauth-transaction-store.js';
import {
	googleIdentityScopes,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';
import {
	type GoogleOAuthCallbackResult,
	type GoogleOAuthRedirectResult,
} from './google-oauth-broker-contracts.js';

export interface GoogleProviderAuthorizationCallback {
	handleGoogleCallback(props: {
		readonly authorizationCode: string;
		readonly browserBindingSecret: string;
		readonly oauthState: string;
		readonly redirectUri: string;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): Promise<GoogleOAuthCallbackResult>;
	retryApplication(props: {
		readonly browserBindingSecret: string;
		readonly csrfToken: string;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): GoogleOAuthRedirectResult;
}

export function createGoogleProviderAuthorizationCallback(props: {
	readonly catalog: OAuthCredentialCatalog;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly config: OAuthConfig;
	readonly googleAdapter: GoogleOAuthAdapter;
	readonly isAdmissionOpen: () => boolean;
	readonly now: () => number;
	readonly prepareCallbackRetry: (props: {
		readonly transaction: Extract<
			OAuthCeremonyTransaction,
			{ readonly kind: 'consuming-callback' }
		>;
	}) => Extract<GoogleOAuthCallbackResult, { readonly kind: 'partial-completion' }>;
	readonly providerSignal: AbortSignal;
	readonly transactionStore: OAuthTransactionStore<GoogleProviderAuthorization>;
	readonly zoneId: string;
}): GoogleProviderAuthorizationCallback {
	return {
		handleGoogleCallback: async (callbackProps): Promise<GoogleOAuthCallbackResult> => {
			const current = props.transactionStore.getTransaction(callbackProps.transactionId);
			if (
				current?.kind !== 'authorizing-application' ||
				!oauthBrowserSecretsEqual(current.browserBindingSecret, callbackProps.browserBindingSecret)
			) {
				return { kind: 'failed', reason: 'browser-binding-mismatch' };
			}
			const consumption = props.transactionStore.beginCallbackConsumption(callbackProps);
			if (consumption.kind !== 'accepted') {
				return { kind: 'failed', reason: consumption.reason };
			}
			const applicationId = googleOAuthApplicationIdSchema.parse(
				consumption.transaction.applicationId,
			);
			const exchange = await props.googleAdapter.exchangeAuthorizationCode({
				authorizationCode: callbackProps.authorizationCode,
				clientCredentials: props.clientCredentialsByApplication[applicationId],
				pkceVerifier: consumption.transaction.pkceVerifier,
				redirectUri: consumption.transaction.redirectUri,
				signal: props.providerSignal,
			});
			if (exchange.kind === 'failed') {
				if (!props.isAdmissionOpen()) {
					return { kind: 'failed', reason: exchange.failure.kind };
				}
				return props.prepareCallbackRetry({ transaction: consumption.transaction });
			}
			const actualScopes = new Set(exchange.authorization.grantedScopes);
			const allowedScopes = new Set([
				...consumption.transaction.confirmedScopes,
				...googleIdentityScopes,
			]);
			if (exchange.authorization.grantedScopes.some((scope) => !allowedScopes.has(scope))) {
				props.transactionStore.cancelTransaction({
					agentId: current.agentId,
					transactionId: current.transactionId,
				});
				return { kind: 'failed', reason: 'scope-insufficient' };
			}
			if (consumption.transaction.confirmedScopes.some((scope) => !actualScopes.has(scope))) {
				return props.prepareCallbackRetry({ transaction: consumption.transaction });
			}
			const existingSubjects = new Set(
				props.catalog
					.listGrantsForAgent({ agentId: current.agentId, zoneId: props.zoneId })
					.filter((grant) => grant.accountProfileId === current.accountProfileId)
					.map((grant) => grant.providerSubject),
			);
			const profileMetadata = props.catalog.getAccountProfileMetadata({
				accountProfileId: current.accountProfileId,
				agentId: current.agentId,
				zoneId: props.zoneId,
			});
			if (profileMetadata !== undefined) {
				existingSubjects.add(profileMetadata.providerSubject);
			}
			if (
				existingSubjects.size > 0 &&
				!existingSubjects.has(exchange.authorization.accountSubject)
			) {
				props.transactionStore.cancelTransaction({
					agentId: current.agentId,
					transactionId: current.transactionId,
				});
				return { kind: 'failed', reason: 'subject-mismatch' };
			}
			const completionResult = props.transactionStore.completeCallback({
				providerGrant: exchange.authorization,
				transactionId: current.transactionId,
			});
			if (completionResult.kind === 'capacity-exhausted') {
				return props.prepareCallbackRetry({ transaction: consumption.transaction });
			}
			const completion = completionResult.session;
			const application = props.config.providers.google.applications[applicationId];
			return {
				confirmation: {
					accountLabel: exchange.authorization.accountEmail,
					applicationLabel: application.label,
					browserBindingSecret: completion.browserBindingSecret,
					completionSessionId: completion.completionSessionId,
					csrfToken: completion.csrfSecret,
					expiresAtMs: completion.expiresAtMs,
					grantedPermissionLabels: Object.values(application.services)
						.filter((service) => service.read.some((scope) => actualScopes.has(scope)))
						.map((service) => service.label),
				},
				kind: 'confirmation',
			};
		},
		retryApplication: (retryProps): GoogleOAuthRedirectResult => {
			const transaction = props.transactionStore.getTransaction(retryProps.transactionId);
			if (transaction?.kind !== 'authorizing-application') {
				throw new Error('OAuth retry transaction is not authorizing an application.');
			}
			if (transaction.expiresAtMs <= props.now()) {
				props.transactionStore.cancelTransaction({
					agentId: transaction.agentId,
					transactionId: transaction.transactionId,
				});
				throw new Error('OAuth retry transaction expired.');
			}
			if (
				transaction.tailnetLogin !== retryProps.tailnetLogin ||
				!oauthBrowserSecretsEqual(
					transaction.browserBindingSecret,
					retryProps.browserBindingSecret,
				) ||
				!oauthBrowserSecretsEqual(transaction.csrfSecret, retryProps.csrfToken)
			) {
				throw new Error('OAuth retry authority is invalid.');
			}
			const applicationId = googleOAuthApplicationIdSchema.parse(transaction.applicationId);
			return {
				applicationId: oauthApplicationIdSchema.parse(applicationId),
				applicationLabel: props.config.providers.google.applications[applicationId].label,
				authorizationUrl: props.googleAdapter.buildAuthorizationUrl({
					clientCredentials: props.clientCredentialsByApplication[applicationId],
					pkceChallenge: transaction.pkceChallenge,
					redirectUri: transaction.redirectUri,
					requestedScopes: transaction.confirmedScopes,
					state: transaction.oauthState,
				}),
				browserBindingSecret: transaction.browserBindingSecret,
				expiresAtMs: transaction.expiresAtMs,
				kind: 'redirect',
				transactionId: transaction.transactionId,
			};
		},
	};
}
