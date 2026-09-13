import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	type OAuthBrowserSessionIdentity,
	type OAuthCompletionSessionId,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';

import { type OAuthKeyEncryptionKey } from '../envelope-codec.js';
import { oauthBrowserSecretsEqual } from '../oauth-browser-security.js';
import {
	oauthStoredGrantSchema,
	type OAuthCredentialCatalog,
} from '../oauth-credential-catalog-contracts.js';
import {
	sameOAuthBrowserSession,
	type OAuthCompletionSession,
	type OAuthCeremonyTransaction,
	type OAuthTransactionStore,
} from '../oauth-transaction-store.js';
import { decryptGoogleCredentialPayload } from './google-credential-payload.js';
import {
	googleProviderAuthorizationSchema,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';
import {
	type GoogleOAuthCallbackResult,
	type GoogleOAuthConfirmationPageData,
	type GoogleOAuthRedirectResult,
	type GoogleOAuthRetryPageData,
} from './google-oauth-broker-contracts.js';
import { type GoogleOAuthPermissionPolicy } from './google-oauth-permission-policy.js';
import { getGooglePermissionGroups } from './google-permission-catalog.js';

interface GoogleCallbackBrowserInput {
	readonly browserBindingSecret: string;
	/** Supplied only after host-side verification of the active bound Clerk session. */
	readonly identity: OAuthBrowserSessionIdentity;
	readonly transactionId: OAuthTransactionId;
}
export interface GoogleProviderAuthorizationCallback {
	handleGoogleCallback(
		props: GoogleCallbackBrowserInput & {
			readonly authorizationCode: string;
			readonly oauthState: string;
			readonly redirectUri: string;
		},
	): Promise<GoogleOAuthCallbackResult>;
	getConfirmationPage(props: {
		readonly browserBindingSecret: string;
		readonly completionSessionId: OAuthCompletionSessionId;
		readonly identity: OAuthBrowserSessionIdentity;
	}): GoogleOAuthConfirmationPageData;
	getRetryPage(props: GoogleCallbackBrowserInput): GoogleOAuthRetryPageData;
	retryApplication(
		props: GoogleCallbackBrowserInput & {
			readonly csrfToken: string;
		},
	): GoogleOAuthRedirectResult;
}
type GoogleCallbackTransaction = Extract<
	OAuthCeremonyTransaction,
	{ readonly kind: 'authorizing-application' | 'consuming-callback' }
>;
type GoogleCallbackContext =
	| GoogleCallbackTransaction
	| OAuthCompletionSession<GoogleProviderAuthorization>;

export function createGoogleProviderAuthorizationCallback(props: {
	readonly catalog: Pick<
		OAuthCredentialCatalog,
		'findAccount' | 'getAccountMetadata' | 'getAuthorizationForAccountApplication'
	>;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly config: OAuthConfig;
	readonly configRevision: string;
	readonly googleAdapter: GoogleOAuthAdapter;
	readonly isAdmissionOpen: () => boolean;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly now: () => number;
	readonly permissionPolicy: GoogleOAuthPermissionPolicy;
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
	const permissionGroups = getGooglePermissionGroups();
	const permissionLabels = (groupIds: readonly string[]): readonly string[] => {
		const selected = new Set(groupIds);
		const labels = permissionGroups
			.filter((group) => selected.has(group.groupId))
			.map((group) => group.label);
		if (labels.length !== selected.size)
			throw new Error('Permission selection contains an unknown Google permission group.');
		return labels;
	};
	const previousPermissionLabels = (
		transaction: GoogleCallbackContext,
	): readonly string[] | undefined => {
		if (transaction.target.kind !== 'reauthorize') return undefined;
		const authorization = props.catalog.getAuthorizationForAccountApplication({
			accountId: transaction.target.accountId,
			agentId: transaction.agentId,
			applicationId: transaction.applicationId,
			zoneId: props.zoneId,
		});
		if (authorization === undefined) throw new Error('Existing authorization is unavailable.');
		const grant = oauthStoredGrantSchema.strip().parse(authorization);
		const payload = decryptGoogleCredentialPayload({
			grant,
			keyEncryptionKey: props.keyEncryptionKey,
		});
		return permissionLabels(payload.authority.selectedGroupIds);
	};
	const cancel = (transaction: GoogleCallbackTransaction): void => {
		props.transactionStore.cancelTransaction({
			agentId: transaction.agentId,
			transactionId: transaction.transactionId,
		});
	};
	const contextFailure = (transaction: GoogleCallbackContext): string | undefined => {
		if (!props.isAdmissionOpen() || props.providerSignal.aborted) return 'unavailable';
		if (transaction.expiresAtMs <= props.now()) return 'expired';
		if (transaction.configRevision !== props.configRevision || props.config.zoneId !== props.zoneId)
			return 'configuration-change-required';
		if (
			transaction.identity.issuer !== props.config.browser.identity.issuer ||
			!Object.values(props.config.owners).some(
				(owner) =>
					owner.clerkUserId === transaction.identity.userId &&
					owner.allowedAgentIds.includes(transaction.agentId),
			)
		)
			return 'authorization-denied';
		const applicationId = googleOAuthApplicationIdSchema.safeParse(transaction.applicationId);
		if (!applicationId.success || transaction.target.kind === 'disconnect')
			return 'authorization-denied';
		try {
			const selections = props.permissionPolicy.validateSelections({
				agentId: transaction.agentId,
				selections: transaction.confirmedSelections,
			});
			const scopes = props.permissionPolicy.scopesForApplication(applicationId.data, selections);
			const confirmed = new Set(transaction.confirmedScopes);
			if (
				scopes.length === 0 ||
				scopes.length !== confirmed.size ||
				scopes.some((scope) => !confirmed.has(scope))
			)
				return 'scope-mismatch';
		} catch {
			return 'configuration-change-required';
		}
		const target = transaction.target;
		const binding = target.kind === 'enroll' ? target.accountBinding : target;
		if (binding === undefined) return undefined;
		const account = props.catalog.getAccountMetadata(binding.accountId);
		if (
			account === undefined ||
			account.zoneId !== props.zoneId ||
			account.providerId !== 'google' ||
			account.owner.issuer !== transaction.identity.issuer ||
			account.owner.userId !== transaction.identity.userId
		)
			return 'authorization-denied';
		if (account.providerSubject !== binding.providerSubject) return 'subject-mismatch';
		if (target.kind === 'reauthorize') {
			const authorization = props.catalog.getAuthorizationForAccountApplication({
				accountId: target.accountId,
				agentId: transaction.agentId,
				applicationId: transaction.applicationId,
				zoneId: props.zoneId,
			});
			if (
				target.applicationId !== transaction.applicationId ||
				authorization === undefined ||
				authorization.accessState !== 'connected' ||
				authorization.authorizationId !== target.authorizationId ||
				authorization.generation !== target.generation ||
				authorization.authorizationMetadataRevision !== target.authorizationMetadataRevision
			)
				return 'stale-authorization';
		}
		return undefined;
	};
	const confirmationPageData = (
		completion: OAuthCompletionSession<GoogleProviderAuthorization>,
	): GoogleOAuthConfirmationPageData => {
		const failure = contextFailure(completion);
		if (failure !== undefined) throw new Error(`OAuth completion is unavailable: ${failure}`);
		const authorization = googleProviderAuthorizationSchema.parse(completion.providerGrant);
		const priorPermissionLabels = previousPermissionLabels(completion);
		return {
			accountLabel: authorization.accountEmail,
			applicationLabel:
				props.config.providers.google.applications[
					googleOAuthApplicationIdSchema.parse(completion.applicationId)
				].label,
			browserBindingSecret: completion.browserBindingSecret,
			completionSessionId: completion.completionSessionId,
			csrfToken: completion.csrfSecret,
			expiresAtMs: completion.expiresAtMs,
			...(priorPermissionLabels === undefined
				? {}
				: { previousPermissionLabels: priorPermissionLabels }),
			grantedPermissionLabels: permissionLabels(
				completion.confirmedSelections[completion.applicationId] ?? [],
			),
		};
	};
	const providerAccountFailure = (
		transaction: GoogleCallbackTransaction,
		authorization: GoogleProviderAuthorization,
	): string | undefined => {
		const target = transaction.target;
		const binding = target.kind === 'enroll' ? target.accountBinding : target;
		if (binding !== undefined && binding.providerSubject !== authorization.accountSubject)
			return 'subject-mismatch';
		const account = props.catalog.findAccount({
			zoneId: props.zoneId,
			providerId: 'google',
			providerSubject: authorization.accountSubject,
		});
		if (account === undefined) return binding === undefined ? undefined : 'subject-mismatch';
		if (
			account.owner.issuer !== transaction.identity.issuer ||
			account.owner.userId !== transaction.identity.userId
		)
			return 'authorization-denied';
		if (binding !== undefined && binding.accountId !== account.accountId) return 'subject-mismatch';
		if (target.kind === 'enroll') {
			const existing = props.catalog.getAuthorizationForAccountApplication({
				accountId: account.accountId,
				agentId: transaction.agentId,
				applicationId: transaction.applicationId,
				zoneId: props.zoneId,
			});
			if (existing !== undefined && existing.accessState !== 'disconnected')
				return 'duplicate-authorization';
		}
		return undefined;
	};

	return {
		getConfirmationPage: (input): GoogleOAuthConfirmationPageData => {
			const completion = props.transactionStore.getCompletionSession(input.completionSessionId);
			if (
				completion?.kind !== 'awaiting-account-confirmation' ||
				!sameOAuthBrowserSession(completion.identity, input.identity) ||
				!oauthBrowserSecretsEqual(completion.browserBindingSecret, input.browserBindingSecret)
			)
				throw new Error('OAuth account confirmation authority is invalid.');
			return confirmationPageData(completion);
		},
		getRetryPage: (input): GoogleOAuthRetryPageData => {
			const transaction = props.transactionStore.getTransaction(input.transactionId);
			if (
				transaction?.kind !== 'authorizing-application' ||
				!sameOAuthBrowserSession(transaction.identity, input.identity) ||
				!oauthBrowserSecretsEqual(transaction.browserBindingSecret, input.browserBindingSecret)
			)
				throw new Error('OAuth retry authority is invalid.');
			const failure = contextFailure(transaction);
			if (failure !== undefined) throw new Error(`OAuth retry is unavailable: ${failure}`);
			return {
				completed: transaction.completedApplications,
				csrfToken: transaction.csrfSecret,
				retryable: [transaction.applicationId, ...transaction.remainingApplications],
			};
		},
		handleGoogleCallback: async (callbackProps): Promise<GoogleOAuthCallbackResult> => {
			const current = props.transactionStore.getTransaction(callbackProps.transactionId);
			if (
				current?.kind !== 'authorizing-application' ||
				!oauthBrowserSecretsEqual(current.browserBindingSecret, callbackProps.browserBindingSecret)
			)
				return { kind: 'failed', reason: 'browser-binding-mismatch' };
			if (!sameOAuthBrowserSession(current.identity, callbackProps.identity))
				return { kind: 'failed', reason: 'identity-mismatch' };
			const beforeExchangeFailure = contextFailure(current);
			if (beforeExchangeFailure !== undefined) {
				cancel(current);
				return { kind: 'failed', reason: beforeExchangeFailure };
			}
			try {
				previousPermissionLabels(current);
			} catch {
				cancel(current);
				return { kind: 'failed', reason: 'unavailable' };
			}
			const consumption = props.transactionStore.beginCallbackConsumption(callbackProps);
			if (consumption.kind !== 'accepted') return { kind: 'failed', reason: consumption.reason };
			const transaction = consumption.transaction;
			const applicationId = googleOAuthApplicationIdSchema.parse(transaction.applicationId);
			const exchange = await props.googleAdapter.exchangeAuthorizationCode({
				authorizationCode: callbackProps.authorizationCode,
				clientCredentials: props.clientCredentialsByApplication[applicationId],
				pkceVerifier: transaction.pkceVerifier,
				redirectUri: transaction.redirectUri,
				signal: props.providerSignal,
			});
			// Exchange is an async gap: cancellation, expiry, disconnect and shutdown
			// must win before a returned token can create a confirmation session.
			const afterExchangeFailure = contextFailure(transaction);
			if (afterExchangeFailure !== undefined) {
				cancel(transaction);
				return { kind: 'failed', reason: afterExchangeFailure };
			}
			if (
				props.transactionStore.getTransaction(transaction.transactionId)?.kind !==
				'consuming-callback'
			)
				return { kind: 'failed', reason: 'consumed-or-missing' };
			if (exchange.kind === 'failed') return props.prepareCallbackRetry({ transaction });
			const candidate = googleProviderAuthorizationSchema.safeParse(exchange.authorization);
			if (!candidate.success) {
				cancel(transaction);
				return { kind: 'failed', reason: 'provider-response-invalid' };
			}
			const authorization = candidate.data;
			const actualScopes = new Set(authorization.grantedScopes);
			const expectedScopes = new Set(transaction.confirmedScopes);
			if ([...actualScopes].some((scope) => !expectedScopes.has(scope))) {
				cancel(transaction);
				return { kind: 'failed', reason: 'scope-mismatch' };
			}
			if ([...expectedScopes].some((scope) => !actualScopes.has(scope)))
				return props.prepareCallbackRetry({ transaction });
			const accountFailure = providerAccountFailure(transaction, authorization);
			if (accountFailure !== undefined) {
				cancel(transaction);
				return { kind: 'failed', reason: accountFailure };
			}
			try {
				previousPermissionLabels(transaction);
			} catch {
				cancel(transaction);
				return { kind: 'failed', reason: 'unavailable' };
			}
			const completionResult = props.transactionStore.completeCallback({
				providerGrant: authorization,
				transactionId: transaction.transactionId,
			});
			if (completionResult.kind === 'capacity-exhausted')
				return props.prepareCallbackRetry({ transaction });
			const completion = completionResult.session;
			try {
				return { confirmation: confirmationPageData(completion), kind: 'confirmation' };
			} catch {
				props.transactionStore.cancelCompletion({
					browserBindingSecret: completion.browserBindingSecret,
					completionSessionId: completion.completionSessionId,
					csrfToken: completion.csrfSecret,
					identity: completion.identity,
				});
				return { kind: 'failed', reason: 'unavailable' };
			}
		},
		retryApplication: (retryProps): GoogleOAuthRedirectResult => {
			const transaction = props.transactionStore.getTransaction(retryProps.transactionId);
			if (transaction?.kind !== 'authorizing-application')
				throw new Error('OAuth retry transaction is not authorizing an application.');
			if (
				!sameOAuthBrowserSession(transaction.identity, retryProps.identity) ||
				!oauthBrowserSecretsEqual(
					transaction.browserBindingSecret,
					retryProps.browserBindingSecret,
				) ||
				!oauthBrowserSecretsEqual(transaction.csrfSecret, retryProps.csrfToken)
			)
				throw new Error('OAuth retry authority is invalid.');
			const failure = contextFailure(transaction);
			if (failure !== undefined) {
				cancel(transaction);
				throw new Error('OAuth retry authority is no longer current.');
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
