import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthAuthorizationActionRequestSchema,
	oauthAuthorizationActionResultSchema,
	oauthApplicationIdSchema,
	oauthCompletionSessionIdSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthProviderIdSchema,
	type OAuthAccountProfileId,
	type OAuthApplicationId,
	type OAuthAuthorizationActionResult,
	type OAuthMaterialRevision,
	type OAuthPermissionSelections,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';

import {
	createOAuthEnvelopeCodec,
	oauthEnvelopeBindingSchema,
	type OAuthKeyEncryptionKey,
} from '../envelope-codec.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import {
	createOAuthTransactionStore,
	type OAuthCeremonyTransaction,
	type OAuthTransactionStore,
} from '../oauth-transaction-store.js';
import { createGoogleAuthorizationViewModels } from './google-authorization-view-models.js';
import {
	createGoogleCredentialRefreshCoordinator,
	googleStoredCredentialPayloadSchema,
} from './google-credential-refresh-coordinator.js';
import {
	googleProviderAuthorizationSchema,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';
import {
	type GoogleOAuthBrokerService,
	type GoogleOAuthCallbackResult,
	type GoogleOAuthPermissionSubmissionResult,
} from './google-oauth-broker-contracts.js';
import { createGoogleOAuthPermissionPolicy } from './google-oauth-permission-policy.js';
import { createGoogleProviderAuthorizationCallback } from './google-provider-authorization-callback.js';
import { createGoogleRuntimeCredentialPolicy } from './google-runtime-credential-policy.js';

function secretsEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function materialRevision(): OAuthMaterialRevision {
	return oauthMaterialRevisionSchema.parse(`sha256:${randomBytes(32).toString('base64url')}`);
}

function activeTransactionKey(agentId: string, accountProfileId: OAuthAccountProfileId): string {
	return `${agentId}\0${accountProfileId}`;
}

export function createGoogleOAuthBrokerService(props: {
	readonly catalog: OAuthCredentialCatalog;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly config: OAuthConfig;
	readonly googleAdapter: GoogleOAuthAdapter;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly keyEncryptionKeyVersion: number;
	readonly now?: () => number;
	readonly onCredentialMaterialChanged?: (props: {
		readonly agentId: string;
		readonly zoneId: string;
	}) => Promise<void>;
	readonly transactionStore?: OAuthTransactionStore<GoogleProviderAuthorization>;
	readonly zoneId: string;
}): GoogleOAuthBrokerService {
	const now = props.now ?? Date.now;
	const transactionStore =
		props.transactionStore ??
		createOAuthTransactionStore({
			now,
			providerGrantSchema: googleProviderAuthorizationSchema,
		});
	const activeTransactionIds = new Map<string, OAuthTransactionId>();
	const publicCeremonyIdsByActiveKey = new Map<string, OAuthTransactionId>();
	const currentTransactionIdsByPublicCeremonyId = new Map<OAuthTransactionId, OAuthTransactionId>();
	const terminalAuthorizationResults = new Map<
		OAuthTransactionId,
		{
			readonly agentId: string;
			readonly expiresAtMs: number;
			readonly result:
				| Extract<OAuthAuthorizationActionResult, { readonly kind: 'authorization-completed' }>
				| Extract<OAuthAuthorizationActionResult, { readonly kind: 'authorization-failed' }>;
		}
	>();
	const inFlightOperations = new Set<Promise<unknown>>();
	const providerAbortController = new AbortController();
	let admissionOpen = true;
	let drainPromise: Promise<void> | undefined;
	const requireAdmission = (): void => {
		if (!admissionOpen) throw new Error('OAuth broker admission is closed.');
	};
	const stopAdmission = (): void => {
		if (!admissionOpen) return;
		admissionOpen = false;
		providerAbortController.abort(new Error('OAuth broker is shutting down.'));
		activeTransactionIds.clear();
		publicCeremonyIdsByActiveKey.clear();
		currentTransactionIdsByPublicCeremonyId.clear();
		terminalAuthorizationResults.clear();
		transactionStore.invalidateAll();
	};
	const drain = async (): Promise<void> => {
		stopAdmission();
		drainPromise ??= (async (): Promise<void> => {
			await Promise.allSettled(inFlightOperations);
			transactionStore.invalidateAll();
		})();
		await drainPromise;
	};
	const clearActiveCeremony = (
		agentId: string,
		accountProfileId: OAuthAccountProfileId,
	): OAuthTransactionId | undefined => {
		const key = activeTransactionKey(agentId, accountProfileId);
		const publicCeremonyId = publicCeremonyIdsByActiveKey.get(key);
		activeTransactionIds.delete(key);
		publicCeremonyIdsByActiveKey.delete(key);
		if (publicCeremonyId !== undefined) {
			currentTransactionIdsByPublicCeremonyId.delete(publicCeremonyId);
		}
		return publicCeremonyId;
	};
	const clearActiveCeremonyIfCurrent = (propsForClear: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly expectedTransactionId: OAuthTransactionId;
	}): OAuthTransactionId | undefined => {
		const key = activeTransactionKey(propsForClear.agentId, propsForClear.accountProfileId);
		if (activeTransactionIds.get(key) !== propsForClear.expectedTransactionId) return undefined;
		return clearActiveCeremony(propsForClear.agentId, propsForClear.accountProfileId);
	};
	const reapCompletedAuthorizationResults = (): void => {
		for (const [transactionId, completed] of terminalAuthorizationResults) {
			if (completed.expiresAtMs <= now()) terminalAuthorizationResults.delete(transactionId);
		}
	};
	const trackOperation = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
		requireAdmission();
		const operationPromise = operation();
		inFlightOperations.add(operationPromise);
		try {
			return await operationPromise;
		} finally {
			inFlightOperations.delete(operationPromise);
		}
	};
	const envelopeCodec = createOAuthEnvelopeCodec({
		payloadSchema: googleStoredCredentialPayloadSchema,
	});
	const refreshCoordinator = createGoogleCredentialRefreshCoordinator({
		catalog: props.catalog,
		googleAdapter: props.googleAdapter,
		now,
	});

	const requireAgent = (agentId: string): OAuthConfig['agents'][string] => {
		const agent = props.config.agents[agentId];
		if (agent === undefined) throw new Error(`OAuth agent "${agentId}" is not configured.`);
		return agent;
	};

	const requireAccountProfile = (
		agentId: string,
		accountProfileId: OAuthAccountProfileId,
	): ReturnType<typeof requireAgent>['accountProfiles'][OAuthAccountProfileId] => {
		const profile = requireAgent(agentId).accountProfiles[accountProfileId];
		if (profile === undefined) {
			throw new Error(
				`OAuth account profile "${accountProfileId}" is not assigned to agent "${agentId}".`,
			);
		}
		return profile;
	};
	const permissionPolicy = createGoogleOAuthPermissionPolicy({
		config: props.config,
		requireAccountProfile,
	});

	const startApplication = (startProps: {
		readonly applicationId: GoogleOAuthApplicationId;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly selections: OAuthPermissionSelections;
		readonly transaction: Extract<
			OAuthCeremonyTransaction,
			{ readonly kind: 'selecting-permissions' }
		>;
		readonly remainingApplications: readonly GoogleOAuthApplicationId[];
	}): Extract<GoogleOAuthPermissionSubmissionResult, { readonly kind: 'redirect' }> => {
		const confirmedScopes = permissionPolicy.scopesForApplication(
			startProps.applicationId,
			startProps.selections,
		);
		const authorizing = transactionStore.beginApplicationAuthorization({
			applicationId: oauthApplicationIdSchema.parse(startProps.applicationId),
			completedApplications: startProps.completedApplications,
			confirmedScopes,
			confirmedSelections: startProps.selections,
			redirectUri: new URL('/oauth/google/callback', props.config.browser.publicBaseUrl).toString(),
			remainingApplications: startProps.remainingApplications.map((applicationId) =>
				oauthApplicationIdSchema.parse(applicationId),
			),
			transactionId: startProps.transaction.transactionId,
		});
		return {
			applicationId: oauthApplicationIdSchema.parse(startProps.applicationId),
			applicationLabel: props.config.providers.google.applications[startProps.applicationId].label,
			authorizationUrl: props.googleAdapter.buildAuthorizationUrl({
				clientCredentials: props.clientCredentialsByApplication[startProps.applicationId],
				pkceChallenge: authorizing.pkceChallenge,
				redirectUri: authorizing.redirectUri,
				requestedScopes: confirmedScopes,
				state: authorizing.oauthState,
			}),
			browserBindingSecret: authorizing.browserBindingSecret,
			expiresAtMs: authorizing.expiresAtMs,
			kind: 'redirect' as const,
			transactionId: authorizing.transactionId,
		};
	};

	const prepareCallbackRetry = (retryProps: {
		readonly transaction: Extract<
			OAuthCeremonyTransaction,
			{ readonly kind: 'consuming-callback' }
		>;
	}): Extract<GoogleOAuthCallbackResult, { readonly kind: 'partial-completion' }> => {
		const transaction = retryProps.transaction;
		transactionStore.cancelTransaction({
			agentId: transaction.agentId,
			transactionId: transaction.transactionId,
		});
		const retryApplicationIds = [transaction.applicationId, ...transaction.remainingApplications];
		const retryTransaction = transactionStore.createTransaction({
			accountProfileId: transaction.accountProfileId,
			agentId: transaction.agentId,
			applicationIds: retryApplicationIds,
			authorizationMode: transaction.authorizationMode,
			suggestedSelections: transaction.confirmedSelections,
		});
		const boundRetryTransaction = transactionStore.bindTailnetIdentity({
			tailnetLogin: transaction.tailnetLogin,
			transactionId: retryTransaction.transactionId,
		});
		const retry = startApplication({
			applicationId: googleOAuthApplicationIdSchema.parse(transaction.applicationId),
			completedApplications: transaction.completedApplications,
			remainingApplications: transaction.remainingApplications.map((applicationId) =>
				googleOAuthApplicationIdSchema.parse(applicationId),
			),
			selections: transaction.confirmedSelections,
			transaction: boundRetryTransaction,
		});
		const ceremonyKey = activeTransactionKey(transaction.agentId, transaction.accountProfileId);
		const publicCeremonyId =
			publicCeremonyIdsByActiveKey.get(ceremonyKey) ?? transaction.transactionId;
		activeTransactionIds.set(ceremonyKey, retry.transactionId);
		publicCeremonyIdsByActiveKey.set(ceremonyKey, publicCeremonyId);
		currentTransactionIdsByPublicCeremonyId.set(publicCeremonyId, retry.transactionId);
		return {
			completed: transaction.completedApplications.map(
				(applicationId) =>
					props.config.providers.google.applications[
						googleOAuthApplicationIdSchema.parse(applicationId)
					].label,
			),
			kind: 'partial-completion',
			retry,
			retryCsrfToken: boundRetryTransaction.csrfSecret,
			retryable: retryApplicationIds.map(
				(applicationId) =>
					props.config.providers.google.applications[
						googleOAuthApplicationIdSchema.parse(applicationId)
					].label,
			),
		};
	};
	const providerAuthorizationCallback = createGoogleProviderAuthorizationCallback({
		catalog: props.catalog,
		clientCredentialsByApplication: props.clientCredentialsByApplication,
		config: props.config,
		googleAdapter: props.googleAdapter,
		isAdmissionOpen: () => admissionOpen,
		now,
		prepareCallbackRetry,
		providerSignal: providerAbortController.signal,
		transactionStore,
		zoneId: props.zoneId,
	});

	const runtimeCredentialPolicy = createGoogleRuntimeCredentialPolicy({
		catalog: props.catalog,
		clientCredentialsByApplication: props.clientCredentialsByApplication,
		config: props.config,
		isAdmissionOpen: () => admissionOpen,
		keyEncryptionKey: props.keyEncryptionKey,
		keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
		providerSignal: providerAbortController.signal,
		refreshCoordinator,
		requireAccountProfile,
		requireAgent,
		zoneId: props.zoneId,
	});
	const authorizationViewModels = createGoogleAuthorizationViewModels({
		catalog: props.catalog,
		config: props.config,
		now,
		requireAccountProfile,
		requireAgent,
		transactionStore,
		zoneId: props.zoneId,
	});

	const beginAuthorization = (beginProps: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationIds: readonly GoogleOAuthApplicationId[];
		readonly mode: 'enroll-missing' | 'reauthorize-existing';
		readonly suggestedSelections?: OAuthPermissionSelections | undefined;
	}): OAuthAuthorizationActionResult => {
		requireAccountProfile(beginProps.agentId, beginProps.accountProfileId);
		let suggestedSelections: OAuthPermissionSelections | undefined;
		try {
			suggestedSelections =
				beginProps.suggestedSelections === undefined
					? undefined
					: permissionPolicy.validateSelections({
							accountProfileId: beginProps.accountProfileId,
							agentId: beginProps.agentId,
							selections: beginProps.suggestedSelections,
						});
		} catch {
			return oauthAuthorizationActionResultSchema.parse({
				failure: { kind: 'authorization-denied' },
				kind: 'authorization-failed',
			});
		}
		const applicationIds = beginProps.applicationIds.filter((applicationId) => {
			const existingGrant = props.catalog.getGrantForAccountApplication({
				accountProfileId: beginProps.accountProfileId,
				agentId: beginProps.agentId,
				applicationId: oauthApplicationIdSchema.parse(applicationId),
				zoneId: props.zoneId,
			});
			return beginProps.mode === 'enroll-missing'
				? existingGrant === undefined
				: existingGrant !== undefined;
		});
		if (applicationIds.length === 0) {
			return oauthAuthorizationActionResultSchema.parse({
				failure: { kind: 'authorization-denied' },
				kind: 'authorization-failed',
			});
		}
		const key = activeTransactionKey(beginProps.agentId, beginProps.accountProfileId);
		transactionStore.reapExpired();
		reapCompletedAuthorizationResults();
		let existingTransactionId = activeTransactionIds.get(key);
		let existingPublicCeremonyId = publicCeremonyIdsByActiveKey.get(key);
		let existingCeremonyOwner =
			existingTransactionId === undefined
				? undefined
				: transactionStore.getCeremonyOwner(existingTransactionId);
		let existingTransaction =
			existingTransactionId === undefined
				? undefined
				: transactionStore.getTransaction(existingTransactionId);
		if (existingTransactionId !== undefined && existingCeremonyOwner === undefined) {
			clearActiveCeremony(beginProps.agentId, beginProps.accountProfileId);
			existingTransactionId = undefined;
			existingPublicCeremonyId = undefined;
			existingCeremonyOwner = undefined;
			existingTransaction = undefined;
		}
		if (existingTransactionId !== undefined && existingCeremonyOwner !== undefined) {
			return oauthAuthorizationActionResultSchema.parse({
				kind: 'authorization-pending',
				transactionId: existingPublicCeremonyId ?? existingTransactionId,
			});
		}
		const transaction =
			existingTransaction ??
			transactionStore.createTransaction({
				accountProfileId: beginProps.accountProfileId,
				agentId: beginProps.agentId,
				applicationIds: applicationIds.map((applicationId) =>
					oauthApplicationIdSchema.parse(applicationId),
				),
				authorizationMode: beginProps.mode,
				suggestedSelections,
			});
		activeTransactionIds.set(key, transaction.transactionId);
		const publicCeremonyId = existingPublicCeremonyId ?? transaction.transactionId;
		publicCeremonyIdsByActiveKey.set(key, publicCeremonyId);
		currentTransactionIdsByPublicCeremonyId.set(publicCeremonyId, transaction.transactionId);
		return oauthAuthorizationActionResultSchema.parse({
			authorizationUrl: new URL(
				`/oauth/transactions/${transaction.transactionId}`,
				props.config.browser.publicBaseUrl,
			).toString(),
			expiresAt: new Date(transaction.expiresAtMs).toISOString(),
			kind: 'authorization-begun',
			transactionId: publicCeremonyId,
		});
	};

	return {
		cancelBrowserCompletion: (cancelProps) => {
			requireAdmission();
			const cancelled = transactionStore.cancelCompletion({
				browserBindingSecret: cancelProps.browserBindingSecret,
				completionSessionId: oauthCompletionSessionIdSchema.parse(cancelProps.completionSessionId),
				csrfToken: cancelProps.csrfToken,
				tailnetLogin: cancelProps.tailnetLogin,
			});
			if (cancelled === undefined) return false;
			clearActiveCeremony(cancelled.agentId, cancelled.accountProfileId);
			return true;
		},
		cancelBrowserTransaction: (cancelProps) => {
			requireAdmission();
			const transaction = transactionStore.getTransaction(cancelProps.transactionId);
			if (
				transaction === undefined ||
				(transaction.kind !== 'selecting-permissions' &&
					transaction.kind !== 'authorizing-application') ||
				transaction.tailnetLogin !== cancelProps.tailnetLogin ||
				!secretsEqual(transaction.browserBindingSecret, cancelProps.browserBindingSecret) ||
				!secretsEqual(transaction.csrfSecret, cancelProps.csrfToken)
			) {
				return false;
			}
			const cancelled = transactionStore.cancelPendingTransaction({
				agentId: transaction.agentId,
				transactionId: transaction.transactionId,
			});
			if (cancelled) {
				clearActiveCeremony(transaction.agentId, transaction.accountProfileId);
			}
			return cancelled;
		},
		close: async (): Promise<void> => {
			await drain();
		},
		drain,
		confirmAccount: async (confirmProps) =>
			await trackOperation(async () => {
				const completion = transactionStore.beginCompletionCommit({
					browserBindingSecret: confirmProps.browserBindingSecret,
					completionSessionId: oauthCompletionSessionIdSchema.parse(
						confirmProps.completionSessionId,
					),
					csrfToken: confirmProps.csrfToken,
					tailnetLogin: confirmProps.tailnetLogin,
				});
				if (completion.kind !== 'accepted') {
					throw new Error(`OAuth completion was rejected: ${completion.reason}.`);
				}
				const session = completion.session;
				const publicCeremonyId =
					publicCeremonyIdsByActiveKey.get(
						activeTransactionKey(session.agentId, session.accountProfileId),
					) ?? session.transactionId;
				let durableGrantCommitted = false;
				let completedAuthorizationResult:
					| Extract<OAuthAuthorizationActionResult, { readonly kind: 'authorization-completed' }>
					| undefined;
				let successorTransactionId: OAuthTransactionId | undefined;
				try {
					const existingGrant = props.catalog.getGrantForAccountApplication({
						accountProfileId: session.accountProfileId,
						agentId: session.agentId,
						applicationId: session.applicationId,
						zoneId: props.zoneId,
					});
					const existingScopeSet = new Set(existingGrant?.grantedScopes ?? []);
					const replacementScopeSet = new Set(session.providerGrant.grantedScopes);
					const enrollmentModeIsValid =
						(session.authorizationMode === 'enroll-missing' && existingGrant === undefined) ||
						(session.authorizationMode === 'reauthorize-existing' &&
							existingGrant !== undefined &&
							[...existingScopeSet].every((scope) => replacementScopeSet.has(scope)));
					if (!enrollmentModeIsValid) {
						transactionStore.finishCompletion(session.completionSessionId);
						clearActiveCeremony(session.agentId, session.accountProfileId);
						return { kind: 'authorization-denied' };
					}
					const credentialId =
						existingGrant?.credentialId ?? oauthCredentialIdSchema.parse(randomUUID());
					const envelope = envelopeCodec.encrypt({
						binding: oauthEnvelopeBindingSchema.parse({
							accountProfileId: session.accountProfileId,
							applicationId: session.applicationId,
							credentialId,
							providerId: oauthProviderIdSchema.parse('google'),
							providerSubject: session.providerGrant.accountSubject,
						}),
						keyEncryptionKey: props.keyEncryptionKey,
						keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
						payload: {
							accessToken: session.providerGrant.accessToken,
							accessTokenExpiresAtMs: session.providerGrant.accessTokenExpiresAtMs,
							refreshToken: session.providerGrant.refreshToken,
						},
					});
					const enrolledApplicationIds = new Set(
						props.catalog
							.listGrantsForAgent({ agentId: session.agentId, zoneId: props.zoneId })
							.filter((grant) => grant.accountProfileId === session.accountProfileId)
							.map((grant) => grant.applicationId),
					);
					enrolledApplicationIds.add(session.applicationId);
					const assignedApplicationIds = Object.keys(
						requireAccountProfile(session.agentId, session.accountProfileId).applications,
					).map((applicationId) => oauthApplicationIdSchema.parse(applicationId));
					const parsedCompletedAuthorizationResult = oauthAuthorizationActionResultSchema.parse({
						accountLabel: session.providerGrant.accountEmail,
						accountProfileId: session.accountProfileId,
						applicationId: session.applicationId,
						grantedScopes: session.providerGrant.grantedScopes,
						kind: 'authorization-completed',
					});
					if (parsedCompletedAuthorizationResult.kind !== 'authorization-completed') {
						throw new Error('OAuth completed authorization result validation changed its kind.');
					}
					completedAuthorizationResult = parsedCompletedAuthorizationResult;
					const committed = props.catalog.commitEnrollmentGrant({
						accountLabel: session.providerGrant.accountEmail,
						accountProfileId: session.accountProfileId,
						accountProfileStatus: assignedApplicationIds.every((applicationId) =>
							enrolledApplicationIds.has(applicationId),
						)
							? 'enrolled'
							: 'partially-enrolled',
						agentId: session.agentId,
						applicationId: session.applicationId,
						credentialId,
						envelope,
						grantedScopes: session.providerGrant.grantedScopes,
						materialRevision: materialRevision(),
						providerCredentialVersion: (existingGrant?.providerCredentialVersion ?? 0) + 1,
						providerId: oauthProviderIdSchema.parse('google'),
						providerSubject: session.providerGrant.accountSubject,
						zoneId: props.zoneId,
					});
					transactionStore.finishCompletion(session.completionSessionId);
					if (committed.kind === 'subject-mismatch') {
						clearActiveCeremony(session.agentId, session.accountProfileId);
						return { kind: 'subject-mismatch' };
					}
					durableGrantCommitted = true;
					const nextApplication = session.remainingApplications[0];
					if (nextApplication === undefined) {
						clearActiveCeremonyIfCurrent({
							accountProfileId: session.accountProfileId,
							agentId: session.agentId,
							expectedTransactionId: session.transactionId,
						});
						await props.onCredentialMaterialChanged?.({
							agentId: session.agentId,
							zoneId: props.zoneId,
						});
						terminalAuthorizationResults.set(publicCeremonyId, {
							agentId: session.agentId,
							expiresAtMs: now() + 10 * 60_000,
							result: completedAuthorizationResult,
						});
						return { accountLabel: session.providerGrant.accountEmail, kind: 'completed' };
					}
					const nextTransaction = transactionStore.createTransaction({
						accountProfileId: session.accountProfileId,
						agentId: session.agentId,
						applicationIds: session.remainingApplications,
						authorizationMode: session.authorizationMode,
						suggestedSelections: session.confirmedSelections,
					});
					successorTransactionId = nextTransaction.transactionId;
					const boundNextTransaction = transactionStore.bindTailnetIdentity({
						tailnetLogin: session.tailnetLogin,
						transactionId: nextTransaction.transactionId,
					});
					activeTransactionIds.set(
						activeTransactionKey(session.agentId, session.accountProfileId),
						nextTransaction.transactionId,
					);
					currentTransactionIdsByPublicCeremonyId.set(
						publicCeremonyId,
						nextTransaction.transactionId,
					);
					const redirect = startApplication({
						applicationId: googleOAuthApplicationIdSchema.parse(nextApplication),
						completedApplications: [...session.completedApplications, session.applicationId],
						remainingApplications: session.remainingApplications
							.slice(1)
							.map((applicationId) => googleOAuthApplicationIdSchema.parse(applicationId)),
						selections: session.confirmedSelections,
						transaction: boundNextTransaction,
					});
					await props.onCredentialMaterialChanged?.({
						agentId: session.agentId,
						zoneId: props.zoneId,
					});
					const ceremonyKey = activeTransactionKey(session.agentId, session.accountProfileId);
					const successorOwner = transactionStore.getCeremonyOwner(nextTransaction.transactionId);
					if (
						activeTransactionIds.get(ceremonyKey) !== nextTransaction.transactionId ||
						successorOwner === undefined
					) {
						return { kind: 'authorization-denied' };
					}
					return {
						...redirect,
						applications: authorizationViewModels.applicationProgress({
							authorizingApplication: oauthApplicationIdSchema.parse(nextApplication),
							completedApplications: [...session.completedApplications, session.applicationId],
							remainingApplications: session.remainingApplications.slice(1),
						}),
						csrfToken: boundNextTransaction.csrfSecret,
					};
				} catch (error) {
					transactionStore.finishCompletion(session.completionSessionId);
					if (successorTransactionId !== undefined) {
						transactionStore.cancelTransaction({
							agentId: session.agentId,
							transactionId: successorTransactionId,
						});
					}
					if (durableGrantCommitted) {
						const failedAuthorizationResult = oauthAuthorizationActionResultSchema.parse({
							failure: { kind: 'unavailable' },
							kind: 'authorization-failed',
						});
						if (failedAuthorizationResult.kind !== 'authorization-failed') {
							throw new Error('OAuth failed authorization result validation changed its kind.', {
								cause: error,
							});
						}
						terminalAuthorizationResults.set(publicCeremonyId, {
							agentId: session.agentId,
							expiresAtMs: now() + 10 * 60_000,
							result: failedAuthorizationResult,
						});
					}
					clearActiveCeremonyIfCurrent({
						accountProfileId: session.accountProfileId,
						agentId: session.agentId,
						expectedTransactionId: successorTransactionId ?? session.transactionId,
					});
					throw error;
				}
			}),
		executeAuthorizationAction: async ({ agentId, request: unparsedRequest }) =>
			await trackOperation(async () => {
				const request = oauthAuthorizationActionRequestSchema.parse(unparsedRequest);
				switch (request.actionId) {
					case 'oauth_authorization.list':
						return authorizationViewModels.listAuthorizations(agentId);
					case 'oauth_authorization.begin': {
						const profile = requireAccountProfile(agentId, request.accountProfileId);
						return beginAuthorization({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationIds: Object.keys(profile.applications).map((applicationId) =>
								googleOAuthApplicationIdSchema.parse(applicationId),
							),
							mode: 'enroll-missing',
							suggestedSelections: request.suggestedSelections,
						});
					}
					case 'oauth_authorization.status': {
						const currentTransactionId =
							currentTransactionIdsByPublicCeremonyId.get(request.transactionId) ??
							request.transactionId;
						const ceremonyOwner = transactionStore.getCeremonyOwner(currentTransactionId);
						if (ceremonyOwner !== undefined) {
							return ceremonyOwner.agentId === agentId
								? { kind: 'authorization-pending', transactionId: request.transactionId }
								: { failure: { kind: 'consumed' }, kind: 'authorization-failed' };
						}
						reapCompletedAuthorizationResults();
						const completed = terminalAuthorizationResults.get(request.transactionId);
						return completed?.agentId === agentId
							? completed.result
							: { failure: { kind: 'consumed' }, kind: 'authorization-failed' };
					}
					case 'oauth_authorization.cancel': {
						const currentTransactionId =
							currentTransactionIdsByPublicCeremonyId.get(request.transactionId) ??
							request.transactionId;
						const ceremonyOwner = transactionStore.getCeremonyOwner(currentTransactionId);
						if (ceremonyOwner !== undefined && ceremonyOwner.agentId === agentId) {
							const cancelled = transactionStore.cancelPendingTransaction({
								agentId,
								transactionId: currentTransactionId,
							});
							if (!cancelled) {
								return {
									kind: 'authorization-pending',
									transactionId: request.transactionId,
								};
							}
							clearActiveCeremony(agentId, ceremonyOwner.accountProfileId);
						}
						return { kind: 'authorization-cancelled' };
					}
					case 'oauth_authorization.reauthorize': {
						const applicationId = googleOAuthApplicationIdSchema.parse(request.applicationId);
						const profile = requireAccountProfile(agentId, request.accountProfileId);
						if (profile.applications[applicationId] === undefined) {
							throw new Error('OAuth application is not assigned to this account profile.');
						}
						return beginAuthorization({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationIds: [applicationId],
							mode: 'reauthorize-existing',
							suggestedSelections: request.suggestedSelections,
						});
					}
					case 'oauth_authorization.revoke': {
						const applicationId = googleOAuthApplicationIdSchema.parse(request.applicationId);
						const grant = props.catalog.getGrantForAccountApplication({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationId: oauthApplicationIdSchema.parse(applicationId),
							zoneId: props.zoneId,
						});
						if (grant === undefined) return { kind: 'authorization-revoked' };
						let refreshToken: string | undefined;
						try {
							const payload = envelopeCodec.decrypt({
								binding: oauthEnvelopeBindingSchema.parse({
									accountProfileId: grant.accountProfileId,
									applicationId: grant.applicationId,
									credentialId: grant.credentialId,
									providerId: grant.providerId,
									providerSubject: grant.providerSubject,
								}),
								envelope: grant.envelope,
								keyEncryptionKey: props.keyEncryptionKey,
							});
							refreshToken = payload.refreshToken;
						} catch {
							props.catalog.replaceGrantEnvelope({
								credentialId: grant.credentialId,
								envelope: grant.envelope,
								expectedRecordRevision: grant.recordRevision,
								failureClass: 'credential-corrupt',
								lastRefreshAttemptAtMs: now(),
								lastRefreshSucceededAtMs: grant.lastRefreshSucceededAtMs,
								lifecycleKind: 'reauthorization-required',
								materialRevision: grant.materialRevision,
								nextRefreshEligibleAtMs: null,
								providerCredentialVersion: grant.providerCredentialVersion,
								reauthorizationReason: 'credential-corrupt',
							});
							return {
								failure: { kind: 'unavailable' },
								kind: 'authorization-failed',
							};
						}
						if (refreshToken !== undefined) {
							const revoked = await props.googleAdapter.revokeAuthorization({
								refreshToken,
								signal: providerAbortController.signal,
							});
							if (revoked.kind === 'failed') {
								const alreadyInvalid =
									revoked.failure.kind === 'invalid-grant' ||
									(revoked.failure.kind === 'provider-rejected' &&
										['invalid_grant', 'invalid_token'].includes(revoked.failure.providerError));
								if (!alreadyInvalid) {
									return {
										failure: {
											kind:
												revoked.failure.kind === 'provider-unavailable'
													? 'unavailable'
													: 'authorization-denied',
										},
										kind: 'authorization-failed',
									};
								}
							}
						}
						const deletion = props.catalog.deleteGrantForAccountApplication({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationId: oauthApplicationIdSchema.parse(applicationId),
							expectedCredentialId: grant.credentialId,
							expectedRecordRevision: grant.recordRevision,
							zoneId: props.zoneId,
						});
						if (deletion.kind !== 'deleted') {
							return {
								failure: { kind: 'unavailable' },
								kind: 'authorization-failed',
							};
						}
						await props.onCredentialMaterialChanged?.({ agentId, zoneId: props.zoneId });
						return { kind: 'authorization-revoked' };
					}
				}
			}),
		getPermissionPage: ({ tailnetLogin, transactionId }) => {
			requireAdmission();
			return authorizationViewModels.getPermissionPage({ tailnetLogin, transactionId });
		},
		resolveRuntimeCredential: async (runtimeProps) =>
			await trackOperation(
				async () => await runtimeCredentialPolicy.resolveRuntimeCredential(runtimeProps),
			),
		validateRuntimeCredentialSnapshot: (runtimeProps) =>
			runtimeCredentialPolicy.validateRuntimeCredentialSnapshot(runtimeProps),
		resolveToolAvailability: (availabilityProps) => {
			requireAdmission();
			return runtimeCredentialPolicy.resolveToolAvailability(availabilityProps);
		},
		reapExpiredTransactions: () => {
			reapCompletedAuthorizationResults();
			return transactionStore.reapExpired();
		},
		retryApplication: (retryProps) => {
			requireAdmission();
			return providerAuthorizationCallback.retryApplication(retryProps);
		},
		stopAdmission,
		handleGoogleCallback: async (callbackProps) =>
			await trackOperation(
				async () => await providerAuthorizationCallback.handleGoogleCallback(callbackProps),
			),
		submitPermissions: (submissionProps) => {
			requireAdmission();
			const transaction = transactionStore.getTransaction(submissionProps.transactionId);
			if (transaction?.kind !== 'selecting-permissions') {
				throw new Error('OAuth transaction is not selecting permissions.');
			}
			if (
				transaction.tailnetLogin !== submissionProps.tailnetLogin ||
				!secretsEqual(transaction.browserBindingSecret, submissionProps.browserBindingSecret) ||
				!secretsEqual(transaction.csrfSecret, submissionProps.csrfToken)
			) {
				throw new Error('OAuth permission submission authority is invalid.');
			}
			const selections = permissionPolicy.completeSelections({
				accountProfileId: transaction.accountProfileId,
				agentId: transaction.agentId,
				selections: submissionProps.selections,
			});
			const queue = transaction.applicationIds
				.map((applicationId) => googleOAuthApplicationIdSchema.parse(applicationId))
				.filter(
					(applicationId) =>
						permissionPolicy.scopesForApplication(applicationId, selections).length > 0,
				);
			const firstApplication = queue[0];
			if (firstApplication === undefined) {
				transactionStore.cancelTransaction({
					agentId: transaction.agentId,
					transactionId: transaction.transactionId,
				});
				clearActiveCeremony(transaction.agentId, transaction.accountProfileId);
				return { kind: 'already-satisfied' };
			}
			return startApplication({
				applicationId: firstApplication,
				completedApplications: [],
				remainingApplications: queue.slice(1),
				selections,
				transaction,
			});
		},
	};
}
