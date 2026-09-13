import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	oauthAuthorizationActionRequestSchema,
	oauthAuthorizationActionResultSchema,
	oauthCompletionSessionIdSchema,
	oauthPublicFailureSchema,
	oauthTransactionIdSchema,
	type OAuthApplicationId,
	type OAuthAuthorizationActionRequest,
	type OAuthAuthorizationActionResult,
	type OAuthBrowserSessionIdentity,
	type OAuthPermissionSelections,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';

import { type OAuthKeyEncryptionKey } from '../envelope-codec.js';
import { oauthBrowserSecretsEqual } from '../oauth-browser-security.js';
import {
	type OAuthCeremonyContext,
	type OAuthCeremonyInitiator,
	type OAuthCeremonyTarget,
} from '../oauth-ceremony-contracts.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import {
	createOAuthTransactionStore,
	sameOAuthBrowserSession,
	type OAuthCeremonyTransaction,
	type OAuthTransactionStore,
} from '../oauth-transaction-store.js';
import {
	createGoogleAuthorizationCommitter,
	type OAuthAuthorizationContainmentTarget,
} from './google-authorization-commit.js';
import { disconnectConfirmedGoogleAuthorization } from './google-authorization-disconnect.js';
import { createGoogleAuthorizationViewModels } from './google-authorization-view-models.js';
import { createGoogleCredentialRefreshCoordinator } from './google-credential-refresh-coordinator.js';
import {
	googleProviderAuthorizationSchema,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';
import {
	type GoogleOAuthAccountActivityReader,
	type GoogleOAuthBrokerService,
	type GoogleOAuthBrowserDecision,
	type GoogleOAuthCallbackResult,
	type GoogleOAuthConfirmationResult,
	type GoogleOAuthRedirectResult,
} from './google-oauth-broker-contracts.js';
import {
	createGoogleOAuthPermissionPolicy,
	type GoogleOfferedPermissionGroups,
} from './google-oauth-permission-policy.js';
import { createGoogleProviderAuthorizationCallback } from './google-provider-authorization-callback.js';
import { createGoogleRuntimeCredentialPolicy } from './google-runtime-credential-policy.js';

type BeginRequest = Extract<
	OAuthAuthorizationActionRequest,
	{
		actionId:
			| 'oauth_authorization.begin'
			| 'oauth_authorization.reauthorize'
			| 'oauth_authorization.disconnect';
	}
>;
type SelectingTransaction = Extract<OAuthCeremonyTransaction, { kind: 'selecting-permissions' }>;
interface PublicCeremony {
	readonly agentId: string;
	readonly initiator: OAuthCeremonyInitiator;
	currentTransactionId: OAuthTransactionId;
	expiresAtMs: number;
	result?: OAuthAuthorizationActionResult;
}
export function createGoogleOAuthBrokerService(props: {
	readonly runAuthorityCommit?: <TResult>(commit: () => TResult) => Promise<TResult>;
	readonly catalog: OAuthCredentialCatalog;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly clientBindingRevisionsByApplication: Readonly<Record<GoogleOAuthApplicationId, string>>;
	readonly allowedHostsByApplication: Readonly<Record<GoogleOAuthApplicationId, readonly string[]>>;
	readonly config: OAuthConfig;
	readonly configRevision: string;
	readonly isAdmissionOpen: () => boolean;
	readonly googleAdapter: GoogleOAuthAdapter;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly keyEncryptionKeyVersion: number;
	readonly now?: () => number;
	readonly containAuthorizationMaterial: (
		target: OAuthAuthorizationContainmentTarget,
	) => Promise<'contained' | 'pending' | 'failed'>;
	readonly offeredGroupIdsByAgentApplication: GoogleOfferedPermissionGroups;
	readonly operationIdsByAgent: Readonly<Record<string, readonly string[]>>;
	readonly recommendationSelectionsByAgent: Readonly<Record<string, OAuthPermissionSelections>>;
	readonly readAccountActivity: GoogleOAuthAccountActivityReader;
	readonly transactionStore?: OAuthTransactionStore<GoogleProviderAuthorization>;
}): GoogleOAuthBrokerService {
	const now = props.now ?? Date.now;
	const transactionStore =
		props.transactionStore ??
		createOAuthTransactionStore({ now, providerGrantSchema: googleProviderAuthorizationSchema });
	const ceremonies = new Map<OAuthTransactionId, PublicCeremony>();
	const inFlight = new Set<Promise<unknown>>();
	const providerAbortController = new AbortController();
	let admissionOpen = true;
	const admissionAllowed = (): boolean => admissionOpen && props.isAdmissionOpen();
	let drainPromise: Promise<void> | undefined;
	const requireAdmission = (): void => {
		if (!admissionAllowed()) throw new Error('OAuth broker admission is closed.');
	};
	const permissionPolicy = createGoogleOAuthPermissionPolicy(props);
	for (const [agentId, selections] of Object.entries(props.recommendationSelectionsByAgent))
		permissionPolicy.validateSelections({ agentId, selections });
	const views = createGoogleAuthorizationViewModels({ ...props, permissionPolicy, now });
	const committer = createGoogleAuthorizationCommitter({
		...props,
		permissionPolicy,
		now,
		isAdmissionOpen: admissionAllowed,
	});
	const runtimePolicy = createGoogleRuntimeCredentialPolicy({
		...props,
		permissionPolicy,
		isAdmissionOpen: admissionAllowed,
		providerSignal: providerAbortController.signal,
		refreshCoordinator: createGoogleCredentialRefreshCoordinator({
			catalog: props.catalog,
			googleAdapter: props.googleAdapter,
			now,
		}),
	});
	const failed = (reason: string): OAuthAuthorizationActionResult => {
		const parsed = oauthPublicFailureSchema.safeParse({ kind: reason });
		return {
			kind: 'authorization-failed',
			failure: parsed.success ? parsed.data : { kind: 'unavailable' },
		};
	};
	const reap = (): ReturnType<GoogleOAuthBrokerService['reapExpiredTransactions']> => {
		for (const [id, entry] of ceremonies) {
			if (entry.expiresAtMs > now()) continue;
			transactionStore.cancelTransaction({
				agentId: entry.agentId,
				transactionId: entry.currentTransactionId,
			});
			ceremonies.delete(id);
		}
		return transactionStore.reapExpired();
	};
	const requireCurrent = (context: OAuthCeremonyContext): PublicCeremony => {
		requireAdmission();
		const entry = ceremonies.get(context.publicCeremonyId);
		if (
			entry === undefined ||
			entry.result !== undefined ||
			entry.currentTransactionId !== context.transactionId ||
			entry.expiresAtMs <= now() ||
			context.configRevision !== props.configRevision
		)
			throw new Error('OAuth ceremony is unavailable or stale.');
		return entry;
	};
	const terminal = (
		context: OAuthCeremonyContext,
		result: OAuthAuthorizationActionResult,
	): void => {
		const entry = ceremonies.get(context.publicCeremonyId);
		if (
			!admissionAllowed() ||
			entry === undefined ||
			entry.currentTransactionId !== context.transactionId
		)
			return;
		entry.result = oauthAuthorizationActionResultSchema.parse(result);
		entry.expiresAtMs = now() + 10 * 60_000;
	};
	const requireOwner = (
		identity: OAuthBrowserSessionIdentity,
		context: OAuthCeremonyContext,
	): void => {
		requireCurrent(context);
		if (
			identity.issuer !== props.config.browser.identity.issuer ||
			!Object.values(props.config.owners).some(
				(owner) =>
					owner.clerkUserId === identity.userId && owner.allowedAgentIds.includes(context.agentId),
			)
		)
			throw new Error('OAuth browser owner is not admitted.');
		const binding =
			context.target.kind === 'enroll' ? context.target.accountBinding : context.target;
		if (binding !== undefined) {
			const account = props.catalog.getAccountMetadata(binding.accountId);
			if (
				account === undefined ||
				account.zoneId !== props.config.zoneId ||
				account.providerId !== 'google' ||
				account.providerSubject !== binding.providerSubject ||
				account.owner.issuer !== identity.issuer ||
				account.owner.userId !== identity.userId
			)
				throw new Error('OAuth account is not owned by this browser human.');
		}
	};
	const checkBrowser = (
		transaction: SelectingTransaction,
		decision: GoogleOAuthBrowserDecision,
	): void => {
		requireOwner(decision.identity, transaction);
		if (
			transaction.identity === undefined ||
			!sameOAuthBrowserSession(transaction.identity, decision.identity) ||
			!oauthBrowserSecretsEqual(transaction.browserBindingSecret, decision.browserBindingSecret) ||
			!oauthBrowserSecretsEqual(transaction.csrfSecret, decision.csrfToken)
		)
			throw new Error('OAuth browser decision binding is invalid.');
	};
	const track = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
		requireAdmission();
		const running = operation();
		inFlight.add(running);
		try {
			return await running;
		} finally {
			inFlight.delete(running);
		}
	};
	const startApplication = (input: {
		readonly transaction: SelectingTransaction;
		readonly applicationId: OAuthApplicationId;
		readonly selections: OAuthPermissionSelections;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly remainingApplications: readonly OAuthApplicationId[];
	}): GoogleOAuthRedirectResult => {
		const applicationId = googleOAuthApplicationIdSchema.parse(input.applicationId);
		const authorizing = transactionStore.beginApplicationAuthorization({
			transactionId: input.transaction.transactionId,
			applicationId: input.applicationId,
			confirmedScopes: permissionPolicy.scopesForApplication(applicationId, input.selections),
			confirmedSelections: input.selections,
			completedApplications: input.completedApplications,
			remainingApplications: input.remainingApplications,
			redirectUri: new URL('/oauth/google/callback', props.config.browser.publicBaseUrl).toString(),
		});
		return {
			kind: 'redirect',
			applicationId: input.applicationId,
			applicationLabel: props.config.providers.google.applications[applicationId].label,
			authorizationUrl: props.googleAdapter.buildAuthorizationUrl({
				clientCredentials: props.clientCredentialsByApplication[applicationId],
				pkceChallenge: authorizing.pkceChallenge,
				redirectUri: authorizing.redirectUri,
				requestedScopes: authorizing.confirmedScopes,
				state: authorizing.oauthState,
			}),
			browserBindingSecret: authorizing.browserBindingSecret,
			expiresAtMs: Math.min(authorizing.expiresAtMs, requireCurrent(authorizing).expiresAtMs),
			transactionId: authorizing.transactionId,
		};
	};
	const successor = (
		context: OAuthCeremonyContext & {
			readonly applicationIds: readonly OAuthApplicationId[];
			readonly identity: OAuthBrowserSessionIdentity;
		},
		target: OAuthCeremonyTarget,
	): SelectingTransaction => {
		const entry = requireCurrent(context);
		const next = transactionStore.createTransaction({
			agentId: context.agentId,
			applicationIds: context.applicationIds,
			configRevision: context.configRevision,
			initiator: context.initiator,
			publicCeremonyId: context.publicCeremonyId,
			target,
		});
		entry.currentTransactionId = next.transactionId;
		return transactionStore.bindBrowserIdentity({
			identity: context.identity,
			transactionId: next.transactionId,
		});
	};
	const callback = createGoogleProviderAuthorizationCallback({
		...props,
		permissionPolicy,
		now,
		isAdmissionOpen: admissionAllowed,
		providerSignal: providerAbortController.signal,
		transactionStore,
		zoneId: props.config.zoneId,
		prepareCallbackRetry: ({ transaction }) => {
			const next = successor(transaction, transaction.target);
			transactionStore.cancelTransaction({
				agentId: transaction.agentId,
				transactionId: transaction.transactionId,
			});
			const retry = startApplication({
				transaction: next,
				applicationId: transaction.applicationId,
				selections: transaction.confirmedSelections,
				completedApplications: transaction.completedApplications,
				remainingApplications: transaction.remainingApplications,
			});
			return {
				kind: 'partial-completion',
				completed: transaction.completedApplications,
				retry,
				retryCsrfToken: next.csrfSecret,
				retryable: [transaction.applicationId, ...transaction.remainingApplications],
			};
		},
	});
	const begin = (
		agentId: string,
		request: BeginRequest,
		identity?: OAuthBrowserSessionIdentity,
	): OAuthAuthorizationActionResult => {
		requireAdmission();
		reap();
		const agent = props.config.agents[agentId];
		if (agent === undefined) return failed('authorization-denied');
		const applicationId = googleOAuthApplicationIdSchema.parse(request.applicationId);
		if (
			request.actionId !== 'oauth_authorization.disconnect' &&
			agent.applications[applicationId] === undefined
		)
			return failed('configuration-change-required');
		if (
			identity !== undefined &&
			(identity.issuer !== props.config.browser.identity.issuer ||
				!Object.values(props.config.owners).some(
					(owner) =>
						owner.clerkUserId === identity.userId && owner.allowedAgentIds.includes(agentId),
				))
		)
			return failed('authorization-denied');
		if ('suggestedSelections' in request && request.suggestedSelections !== undefined) {
			try {
				permissionPolicy.validateSelections({ agentId, selections: request.suggestedSelections });
			} catch {
				return failed('configuration-change-required');
			}
		}
		let target: OAuthCeremonyTarget = { kind: 'enroll', applicationId: request.applicationId };
		if (request.actionId !== 'oauth_authorization.begin') {
			const authorization = props.catalog.getAuthorizationForAccountApplication({
				accountId: request.accountId,
				agentId,
				applicationId: request.applicationId,
				zoneId: props.config.zoneId,
			});
			if (
				authorization === undefined ||
				authorization.accessState === 'disconnected' ||
				authorization.accessState === 'disconnecting' ||
				(request.actionId === 'oauth_authorization.reauthorize' &&
					authorization.accessState !== 'connected')
			)
				return failed('authorization-denied');
			if (
				identity !== undefined &&
				(authorization.owner.issuer !== identity.issuer ||
					authorization.owner.userId !== identity.userId)
			)
				return failed('authorization-denied');
			target = {
				kind: request.actionId === 'oauth_authorization.reauthorize' ? 'reauthorize' : 'disconnect',
				accountId: authorization.accountId,
				applicationId: authorization.applicationId,
				authorizationId: authorization.authorizationId,
				authorizationMetadataRevision: authorization.authorizationMetadataRevision,
				generation: authorization.generation,
				providerSubject: authorization.providerSubject,
			};
		}
		if (ceremonies.size >= 128) return failed('unavailable');
		const transaction = transactionStore.createTransaction({
			agentId,
			configRevision: props.configRevision,
			applicationIds:
				target.kind === 'enroll'
					? Object.keys(agent.applications).map((id) => oauthApplicationIdSchema.parse(id))
					: [request.applicationId],
			initiator:
				identity === undefined
					? { kind: 'agent', agentId }
					: {
							kind: 'website_owner',
							ownerIdentity: { issuer: identity.issuer, userId: identity.userId },
						},
			target,
			...('suggestedSelections' in request && request.suggestedSelections !== undefined
				? { suggestedSelections: request.suggestedSelections }
				: {}),
			...('suggestedAlias' in request && request.suggestedAlias !== undefined
				? { suggestedAlias: request.suggestedAlias }
				: {}),
		});
		ceremonies.set(transaction.publicCeremonyId, {
			agentId,
			initiator: transaction.initiator,
			currentTransactionId: transaction.transactionId,
			expiresAtMs: transaction.expiresAtMs,
		});
		if (identity !== undefined)
			transactionStore.bindBrowserIdentity({ identity, transactionId: transaction.transactionId });
		return {
			kind: 'authorization-begun',
			transactionId: transaction.publicCeremonyId,
			authorizationUrl: new URL(
				'/oauth/transactions/' + transaction.transactionId,
				props.config.browser.publicBaseUrl,
			).toString(),
			expiresAt: new Date(transaction.expiresAtMs).toISOString(),
		};
	};
	const stopAdmission = (): void => {
		if (!admissionOpen) return;
		admissionOpen = false;
		providerAbortController.abort(new Error('OAuth broker is shutting down.'));
		transactionStore.invalidateAll();
		ceremonies.clear();
	};
	const drain = async (): Promise<void> => {
		stopAdmission();
		drainPromise ??= Promise.allSettled(inFlight).then(() => {
			transactionStore.invalidateAll();
		});
		await drainPromise;
	};
	return {
		stopAdmission,
		drain,
		close: drain,
		reapExpiredTransactions: reap,
		beginWebsiteAuthorization: ({ agentId, identity, request }) =>
			begin(agentId, request, identity),
		getBrowserSession: (target, browserBindingSecret) => {
			if (target.kind === 'completion') {
				const id = oauthCompletionSessionIdSchema.safeParse(target.id);
				const completion = id.success ? transactionStore.getCompletionSession(id.data) : undefined;
				return completion !== undefined &&
					oauthBrowserSecretsEqual(completion.browserBindingSecret, browserBindingSecret)
					? completion.identity
					: undefined;
			}
			const id = oauthTransactionIdSchema.safeParse(target.id);
			const transaction = id.success ? transactionStore.getTransaction(id.data) : undefined;
			return transaction !== undefined &&
				oauthBrowserSecretsEqual(transaction.browserBindingSecret, browserBindingSecret)
				? transaction.identity
				: undefined;
		},
		getPermissionPage: ({ identity, transactionId }) => {
			const transaction = transactionStore.getTransaction(transactionId);
			if (transaction?.kind !== 'selecting-permissions')
				throw new Error('OAuth transaction is not selecting permissions.');
			requireOwner(identity, transaction);
			return views.getPermissionPage({
				transaction: transactionStore.bindBrowserIdentity({ identity, transactionId }),
			});
		},
		getConfirmationPage: (input) => callback.getConfirmationPage(input),
		getRetryPage: (input) => callback.getRetryPage(input),
		submitPermissions: (input) => {
			const transaction = transactionStore.getTransaction(input.transactionId);
			if (transaction?.kind !== 'selecting-permissions' || transaction.target.kind === 'disconnect')
				throw new Error('OAuth transaction cannot submit Google permissions.');
			checkBrowser(transaction, input);
			const selections = permissionPolicy.completeSelections({
				agentId: transaction.agentId,
				selections: input.selections,
			});
			if (
				Object.entries(selections).some(
					([id, groups]) =>
						groups.length > 0 &&
						!transaction.applicationIds.includes(oauthApplicationIdSchema.parse(id)),
				)
			)
				throw new Error('OAuth selections exceed this ceremony application set.');
			const queue = transaction.applicationIds.filter((id) => (selections[id]?.length ?? 0) > 0);
			const first = queue[0];
			if (first === undefined) {
				transactionStore.cancelTransaction({
					agentId: transaction.agentId,
					transactionId: transaction.transactionId,
				});
				terminal(transaction, { kind: 'authorization-cancelled' });
				return { kind: 'no-selections' };
			}
			return startApplication({
				transaction,
				applicationId: first,
				selections,
				completedApplications: [],
				remainingApplications: queue.slice(1),
			});
		},
		handleGoogleCallback: (input) =>
			track(async (): Promise<GoogleOAuthCallbackResult> => {
				const context = transactionStore.getCeremonyContext(input.transactionId);
				if (context === undefined) return { kind: 'failed', reason: 'consumed' };
				requireOwner(input.identity, context);
				const result = await callback.handleGoogleCallback(input);
				if (result.kind === 'confirmation') {
					const entry = ceremonies.get(context.publicCeremonyId);
					if (entry === undefined || entry.expiresAtMs <= now()) {
						transactionStore.cancelCompletion({
							identity: input.identity,
							completionSessionId: oauthCompletionSessionIdSchema.parse(
								result.confirmation.completionSessionId,
							),
							browserBindingSecret: result.confirmation.browserBindingSecret,
							csrfToken: result.confirmation.csrfToken,
						});
						terminal(context, failed('expired'));
						return { kind: 'failed', reason: 'expired' };
					}
				}
				if (result.kind === 'failed') terminal(context, failed(result.reason));
				return result;
			}),
		retryApplication: (input) => {
			const context = transactionStore.getCeremonyContext(input.transactionId);
			if (context === undefined) throw new Error('OAuth retry is unavailable.');
			requireOwner(input.identity, context);
			return callback.retryApplication(input);
		},
		confirmAccount: (input) =>
			track(async (): Promise<GoogleOAuthConfirmationResult> => {
				const id = oauthCompletionSessionIdSchema.parse(input.completionSessionId);
				const pending = transactionStore.getCompletionSession(id);
				if (pending === undefined) return { kind: 'authorization-denied' };
				requireOwner(input.identity, pending);
				const claim = transactionStore.beginCompletionCommit({ ...input, completionSessionId: id });
				if (claim.kind !== 'accepted') return { kind: 'authorization-denied' };
				const session = claim.session;
				let completionContext: OAuthCeremonyContext = session;
				try {
					const result = await committer.commitConfirmedGrant({
						session,
						accountAlias: input.accountAlias,
					});
					if (result.kind !== 'committed') {
						terminal(
							session,
							'authorization' in result
								? {
										kind:
											result.kind === 'replacement-pending'
												? 'authorization-replacement-pending'
												: 'authorization-containment-failed',
										accountId: result.authorization.accountId,
										applicationId: result.authorization.applicationId,
									}
								: failed(result.kind),
						);
						return { kind: result.kind };
					}
					const authorization = result.authorization;
					const nextApplication = session.remainingApplications[0];
					if (nextApplication !== undefined) {
						const next = successor(session, {
							kind: 'enroll',
							applicationId: nextApplication,
							accountBinding: {
								accountId: authorization.accountId,
								providerSubject: authorization.providerSubject,
							},
						});
						completionContext = next;
						const redirect = startApplication({
							transaction: next,
							applicationId: nextApplication,
							selections: session.confirmedSelections,
							completedApplications: [...session.completedApplications, session.applicationId],
							remainingApplications: session.remainingApplications.slice(1),
						});
						return {
							...redirect,
							csrfToken: next.csrfSecret,
							applications: views.applicationProgress({
								authorizingApplication: nextApplication,
								completedApplications: [...session.completedApplications, session.applicationId],
								remainingApplications: session.remainingApplications.slice(1),
							}),
						};
					}
					terminal(session, {
						kind: 'authorization-completed',
						accountId: authorization.accountId,
						accountAlias: authorization.accountAlias,
						applicationId: authorization.applicationId,
						grantedScopes: authorization.grantedScopes,
					});
					return {
						kind: 'completed',
						accountId: authorization.accountId,
						accountAlias: authorization.accountAlias,
					};
				} catch (error) {
					transactionStore.cancelTransaction({
						agentId: session.agentId,
						transactionId: completionContext.transactionId,
					});
					terminal(completionContext, failed('unavailable'));
					throw error;
				} finally {
					transactionStore.finishCompletion(id);
				}
			}),
		confirmDisconnect: (input) =>
			track(async (): Promise<OAuthAuthorizationActionResult> => {
				const transaction = transactionStore.getTransaction(input.transactionId);
				if (
					transaction?.kind !== 'selecting-permissions' ||
					transaction.target.kind !== 'disconnect'
				)
					return failed('authorization-denied');
				checkBrowser(transaction, input);
				const claim = transactionStore.beginDisconnectCommit(input);
				if (claim.kind !== 'accepted') return failed('authorization-denied');
				try {
					const result = await disconnectConfirmedGoogleAuthorization({
						...(props.runAuthorityCommit === undefined
							? {}
							: { runAuthorityCommit: props.runAuthorityCommit }),
						catalog: props.catalog,
						transaction: claim.transaction,
						containAuthorizationMaterial: props.containAuthorizationMaterial,
						isAdmissionOpen: admissionAllowed,
						zoneId: props.config.zoneId,
					});
					terminal(transaction, result);
					return result;
				} finally {
					transactionStore.finishDisconnect(transaction.transactionId);
				}
			}),
		executeAuthorizationAction: ({ agentId, request: unparsed }) =>
			track(async (): Promise<OAuthAuthorizationActionResult> => {
				const request = oauthAuthorizationActionRequestSchema.parse(unparsed);
				if (props.config.agents[agentId] === undefined) return failed('authorization-denied');
				if (request.actionId === 'oauth_authorization.list')
					return views.listAuthorizations(agentId);
				if (
					request.actionId === 'oauth_authorization.begin' ||
					request.actionId === 'oauth_authorization.reauthorize' ||
					request.actionId === 'oauth_authorization.disconnect'
				)
					return begin(agentId, request);
				reap();
				const entry = ceremonies.get(request.transactionId);
				if (entry === undefined || entry.agentId !== agentId || entry.initiator.kind !== 'agent')
					return failed('consumed');
				if (request.actionId === 'oauth_authorization.status')
					return (
						entry.result ?? { kind: 'authorization-pending', transactionId: request.transactionId }
					);
				if (entry.result !== undefined) return entry.result;
				const cancelled = transactionStore.cancelPendingTransaction({
					agentId,
					transactionId: entry.currentTransactionId,
				});
				if (!cancelled)
					return { kind: 'authorization-pending', transactionId: request.transactionId };
				entry.result = { kind: 'authorization-cancelled' };
				return entry.result;
			}),
		cancelBrowserTransaction: (input) => {
			const transaction = transactionStore.getTransaction(input.transactionId);
			if (
				transaction?.kind !== 'selecting-permissions' &&
				transaction?.kind !== 'authorizing-application'
			)
				return false;
			requireOwner(input.identity, transaction);
			if (
				transaction.identity === undefined ||
				!sameOAuthBrowserSession(transaction.identity, input.identity) ||
				!oauthBrowserSecretsEqual(transaction.browserBindingSecret, input.browserBindingSecret) ||
				!oauthBrowserSecretsEqual(transaction.csrfSecret, input.csrfToken)
			)
				return false;
			const cancelled = transactionStore.cancelTransaction({
				agentId: transaction.agentId,
				transactionId: transaction.transactionId,
			});
			if (cancelled) terminal(transaction, { kind: 'authorization-cancelled' });
			return cancelled;
		},
		cancelBrowserCompletion: (input) => {
			const id = oauthCompletionSessionIdSchema.parse(input.completionSessionId);
			const completion = transactionStore.getCompletionSession(id);
			if (completion === undefined) return false;
			requireOwner(input.identity, completion);
			const context = transactionStore.cancelCompletion({ ...input, completionSessionId: id });
			if (context !== undefined) terminal(context, { kind: 'authorization-cancelled' });
			return context !== undefined;
		},
		cancelBrowserCeremonies: (identity) => {
			const pendingContexts = [...ceremonies.values()].flatMap((entry) => {
				if (entry.result !== undefined) return [];
				const context = transactionStore.getCeremonyContext(entry.currentTransactionId);
				return context === undefined ? [] : [context];
			});
			const count = transactionStore.cancelBrowserCeremonies(identity);
			for (const context of pendingContexts) {
				if (transactionStore.getCeremonyContext(context.transactionId) === undefined)
					terminal(context, { kind: 'authorization-cancelled' });
			}
			return count;
		},
		resolveRuntimeCredential: (request) =>
			track(() => runtimePolicy.resolveRuntimeCredential(request)),
		validateRuntimeCredentialSnapshot: (request) =>
			runtimePolicy.validateRuntimeCredentialSnapshot(request),
	};
}
