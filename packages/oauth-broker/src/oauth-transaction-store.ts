import {
	oauthBrowserSessionIdentitySchema,
	oauthCompletionSessionIdSchema,
	oauthTransactionIdSchema,
	type OAuthApplicationId,
	type OAuthBrowserSessionIdentity,
	type OAuthCompletionSessionId,
	type OAuthPermissionSelections,
	type OAuthScope,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';
import type { z } from 'zod';

import {
	createOAuthOpaqueIdentifier,
	createOAuthPkcePair,
	oauthBrowserSecretsEqual,
} from './oauth-browser-security.js';
import {
	oauthAuthorizingTransactionSchema,
	oauthCeremonyCommonSchema,
	oauthCeremonyContextSchema,
	type oauthCeremonyInitiatorSchema,
	type oauthCeremonyTargetSchema,
	oauthCommittingDisconnectSchema,
	oauthCompletionCommonSchema,
	oauthConsumingTransactionSchema,
	oauthSelectingTransactionSchema,
	type OAuthCallbackCompletionResult,
	type OAuthCallbackConsumptionResult,
	type OAuthCeremonyContext,
	type OAuthCeremonyTransaction,
	type OAuthCompletionCommitResult,
	type OAuthCompletionSession,
} from './oauth-ceremony-contracts.js';

export type {
	OAuthCallbackCompletionResult,
	OAuthCallbackConsumptionResult,
	OAuthCeremonyContext,
	OAuthCeremonyTransaction,
	OAuthCompletionCommitResult,
	OAuthCompletionSession,
} from './oauth-ceremony-contracts.js';

interface BrowserDecisionInput {
	readonly browserBindingSecret: string;
	readonly csrfToken: string;
	readonly identity: OAuthBrowserSessionIdentity;
}
type SelectingTransaction = Extract<
	OAuthCeremonyTransaction,
	{ readonly kind: 'selecting-permissions' }
>;
type AuthorizingTransaction = Extract<
	OAuthCeremonyTransaction,
	{ readonly kind: 'authorizing-application' }
>;
const createTransactionInputSchema = oauthCeremonyCommonSchema
	.omit({
		browserBindingSecret: true,
		createdAtMs: true,
		csrfSecret: true,
		expiresAtMs: true,
		publicCeremonyId: true,
		transactionId: true,
	})
	.extend({ publicCeremonyId: oauthTransactionIdSchema.optional() })
	.strict();
const beginApplicationInputSchema = oauthAuthorizingTransactionSchema
	.pick({
		applicationId: true,
		completedApplications: true,
		confirmedScopes: true,
		confirmedSelections: true,
		redirectUri: true,
		remainingApplications: true,
		transactionId: true,
	})
	.strict();
type DisconnectCommitResult =
	| {
			readonly kind: 'accepted';
			readonly transaction: z.infer<typeof oauthCommittingDisconnectSchema>;
	  }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'expired'
				| 'identity-mismatch'
				| 'browser-binding-mismatch'
				| 'csrf-mismatch'
				| 'wrong-state';
	  };

export interface OAuthTransactionStore<TProviderGrant> {
	/** The host verifies Clerk authentication; this store binds that verified session. */
	createTransaction(props: {
		readonly agentId: string;
		readonly applicationIds: readonly OAuthApplicationId[];
		readonly configRevision: string;
		readonly initiator: z.input<typeof oauthCeremonyInitiatorSchema>;
		readonly publicCeremonyId?: OAuthTransactionId;
		readonly suggestedAlias?: string;
		readonly suggestedSelections?: OAuthPermissionSelections;
		readonly target: z.input<typeof oauthCeremonyTargetSchema>;
	}): SelectingTransaction;
	bindBrowserIdentity(props: {
		readonly identity: OAuthBrowserSessionIdentity;
		readonly transactionId: OAuthTransactionId;
	}): SelectingTransaction;
	beginApplicationAuthorization(props: {
		readonly applicationId: OAuthApplicationId;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly confirmedSelections: OAuthPermissionSelections;
		readonly confirmedScopes: readonly OAuthScope[];
		readonly redirectUri: string;
		readonly remainingApplications: readonly OAuthApplicationId[];
		readonly transactionId: OAuthTransactionId;
	}): AuthorizingTransaction;
	beginCallbackConsumption(props: {
		readonly browserBindingSecret: string;
		readonly identity: OAuthBrowserSessionIdentity;
		readonly oauthState: string;
		readonly redirectUri: string;
		readonly transactionId: OAuthTransactionId;
	}): OAuthCallbackConsumptionResult;
	completeCallback(props: {
		readonly providerGrant: TProviderGrant;
		readonly transactionId: OAuthTransactionId;
	}): OAuthCallbackCompletionResult<TProviderGrant>;
	beginCompletionCommit(
		props: BrowserDecisionInput & { readonly completionSessionId: OAuthCompletionSessionId },
	): OAuthCompletionCommitResult<TProviderGrant>;
	beginDisconnectCommit(
		props: BrowserDecisionInput & { readonly transactionId: OAuthTransactionId },
	): DisconnectCommitResult;
	cancelPendingTransaction(props: {
		readonly agentId: string;
		readonly transactionId: OAuthTransactionId;
	}): boolean;
	/** Broker-owned cleanup, never the agent-facing cancellation path. */
	cancelTransaction(props: {
		readonly agentId: string;
		readonly transactionId: OAuthTransactionId;
	}): boolean;
	cancelCompletion(
		props: BrowserDecisionInput & { readonly completionSessionId: OAuthCompletionSessionId },
	): OAuthCeremonyContext | undefined;
	cancelBrowserCeremonies(identity: OAuthBrowserSessionIdentity): number;
	getCeremonyContext(transactionId: OAuthTransactionId): OAuthCeremonyContext | undefined;
	getTransaction(transactionId: OAuthTransactionId): OAuthCeremonyTransaction | undefined;
	getCompletionSession(
		completionSessionId: OAuthCompletionSessionId,
	): OAuthCompletionSession<TProviderGrant> | undefined;
	finishCompletion(completionSessionId: OAuthCompletionSessionId): boolean;
	finishDisconnect(transactionId: OAuthTransactionId): boolean;
	invalidateAll(): void;
	reapExpired(): { readonly completionSessionCount: number; readonly transactionCount: number };
}

export function sameOAuthBrowserSession(
	left: OAuthBrowserSessionIdentity,
	right: OAuthBrowserSessionIdentity,
): boolean {
	return (
		left.issuer === right.issuer &&
		left.userId === right.userId &&
		left.sessionId === right.sessionId
	);
}

function browserDecisionFailure(
	current: {
		readonly identity?: OAuthBrowserSessionIdentity | undefined;
		readonly browserBindingSecret: string;
		readonly csrfSecret: string;
	},
	input: BrowserDecisionInput,
): 'identity-mismatch' | 'browser-binding-mismatch' | 'csrf-mismatch' | undefined {
	const identity = oauthBrowserSessionIdentitySchema.parse(input.identity);
	if (current.identity === undefined || !sameOAuthBrowserSession(current.identity, identity))
		return 'identity-mismatch';
	if (!oauthBrowserSecretsEqual(current.browserBindingSecret, input.browserBindingSecret))
		return 'browser-binding-mismatch';
	if (!oauthBrowserSecretsEqual(current.csrfSecret, input.csrfToken)) return 'csrf-mismatch';
	return undefined;
}

export function createOAuthTransactionStore<TProviderGrant>(props: {
	readonly completionSessionTtlMs?: number;
	readonly maxCompletionSessions?: number;
	readonly maxTransactions?: number;
	readonly now?: () => number;
	readonly onDiscardProviderGrant?: (providerGrant: TProviderGrant) => void;
	readonly providerGrantSchema: z.ZodType<TProviderGrant>;
	readonly transactionTtlMs?: number;
}): OAuthTransactionStore<TProviderGrant> {
	const now = props.now ?? Date.now;
	const transactionTtlMs = props.transactionTtlMs ?? 10 * 60_000;
	const completionSessionTtlMs = props.completionSessionTtlMs ?? 5 * 60_000;
	const maxTransactions = props.maxTransactions ?? 128;
	const maxCompletionSessions = props.maxCompletionSessions ?? 128;
	for (const value of [
		transactionTtlMs,
		completionSessionTtlMs,
		maxTransactions,
		maxCompletionSessions,
	]) {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new Error('OAuth ceremony limits must be positive safe integers.');
	}
	const transactions = new Map<OAuthTransactionId, OAuthCeremonyTransaction>();
	const completionSessions = new Map<
		OAuthCompletionSessionId,
		OAuthCompletionSession<TProviderGrant>
	>();
	const completionIdsByTransaction = new Map<OAuthTransactionId, OAuthCompletionSessionId>();

	const discardCompletion = (id: OAuthCompletionSessionId): boolean => {
		const session = completionSessions.get(id);
		if (session === undefined) return false;
		completionSessions.delete(id);
		completionIdsByTransaction.delete(session.transactionId);
		props.onDiscardProviderGrant?.(session.providerGrant);
		return true;
	};
	const reapExpired = (): {
		readonly completionSessionCount: number;
		readonly transactionCount: number;
	} => {
		let transactionCount = 0;
		let completionSessionCount = 0;
		for (const [id, transaction] of transactions) {
			if (transaction.expiresAtMs <= now()) {
				transactions.delete(id);
				transactionCount++;
			}
		}
		for (const [id, session] of completionSessions) {
			if (session.expiresAtMs <= now()) {
				discardCompletion(id);
				completionSessionCount++;
			}
		}
		return { completionSessionCount, transactionCount };
	};
	const cancel = (
		input: { readonly agentId: string; readonly transactionId: OAuthTransactionId },
		agentRequest: boolean,
	): boolean => {
		const id = oauthTransactionIdSchema.parse(input.transactionId);
		const transaction = transactions.get(id);
		if (transaction !== undefined) {
			if (transaction.agentId !== input.agentId || transaction.kind === 'committing-disconnect')
				return false;
			if (
				agentRequest &&
				(transaction.initiator.kind !== 'agent' || transaction.kind === 'consuming-callback')
			)
				return false;
			return transactions.delete(id);
		}
		const completionId = completionIdsByTransaction.get(id);
		const completion =
			completionId === undefined ? undefined : completionSessions.get(completionId);
		if (
			completion?.kind !== 'awaiting-account-confirmation' ||
			completion.agentId !== input.agentId
		)
			return false;
		if (agentRequest && completion.initiator.kind !== 'agent') return false;
		return discardCompletion(completion.completionSessionId);
	};

	return {
		createTransaction: (unparsedInput) => {
			const input = createTransactionInputSchema.parse(unparsedInput);
			reapExpired();
			if (transactions.size >= maxTransactions)
				throw new Error('OAuth transaction capacity is exhausted.');
			const transactionId = oauthTransactionIdSchema.parse(createOAuthOpaqueIdentifier());
			const createdAtMs = now();
			const transaction = oauthSelectingTransactionSchema.parse({
				...input,
				browserBindingSecret: createOAuthOpaqueIdentifier(),
				createdAtMs,
				csrfSecret: createOAuthOpaqueIdentifier(),
				expiresAtMs: createdAtMs + transactionTtlMs,
				kind: 'selecting-permissions',
				publicCeremonyId: input.publicCeremonyId ?? transactionId,
				transactionId,
			});
			if (!transaction.applicationIds.includes(transaction.target.applicationId))
				throw new Error('OAuth target is outside the admitted applications.');
			if (transaction.target.kind !== 'enroll' && transaction.applicationIds.length !== 1)
				throw new Error('An existing authorization ceremony targets one application.');
			if (
				transaction.initiator.kind === 'agent' &&
				transaction.initiator.agentId !== transaction.agentId
			)
				throw new Error('OAuth initiator cannot select another agent.');
			transactions.set(transactionId, transaction);
			return transaction;
		},
		bindBrowserIdentity: (input) => {
			const id = oauthTransactionIdSchema.parse(input.transactionId);
			const current = transactions.get(id);
			if (current?.kind !== 'selecting-permissions')
				throw new Error('OAuth transaction is not selecting permissions.');
			if (current.expiresAtMs <= now()) {
				transactions.delete(id);
				throw new Error('OAuth transaction expired.');
			}
			const identity = oauthBrowserSessionIdentitySchema.parse(input.identity);
			if (current.identity !== undefined && !sameOAuthBrowserSession(current.identity, identity))
				throw new Error('OAuth transaction is already bound to another browser session.');
			if (
				current.initiator.kind === 'website_owner' &&
				(current.initiator.ownerIdentity.issuer !== identity.issuer ||
					current.initiator.ownerIdentity.userId !== identity.userId)
			)
				throw new Error('OAuth transaction belongs to another website owner.');
			const bound = oauthSelectingTransactionSchema.parse({ ...current, identity });
			transactions.set(id, bound);
			return bound;
		},
		beginApplicationAuthorization: (unparsedInput) => {
			const input = beginApplicationInputSchema.parse(unparsedInput);
			const id = oauthTransactionIdSchema.parse(input.transactionId);
			const current = transactions.get(id);
			if (current?.kind !== 'selecting-permissions' || current.target.kind === 'disconnect')
				throw new Error('OAuth transaction cannot start Google authorization.');
			if (current.expiresAtMs <= now()) {
				transactions.delete(id);
				throw new Error('OAuth transaction expired.');
			}
			if (current.identity === undefined)
				throw new Error('OAuth transaction has no verified browser session.');
			if (!current.applicationIds.includes(input.applicationId))
				throw new Error('OAuth application is outside this ceremony.');
			const pkce = createOAuthPkcePair();
			const next = oauthAuthorizingTransactionSchema.parse({
				...current,
				...input,
				identity: current.identity,
				kind: 'authorizing-application',
				oauthState: createOAuthOpaqueIdentifier(),
				pkceChallenge: pkce.challenge,
				pkceVerifier: pkce.verifier,
			});
			const progressIds = [
				...next.completedApplications,
				next.applicationId,
				...next.remainingApplications,
			];
			if (
				new Set(progressIds).size !== progressIds.length ||
				progressIds.some((applicationId) => !current.applicationIds.includes(applicationId))
			)
				throw new Error('OAuth application progress is inconsistent.');
			transactions.set(id, next);
			return next;
		},
		beginCallbackConsumption: (input) => {
			const id = oauthTransactionIdSchema.parse(input.transactionId);
			const current = transactions.get(id);
			if (current === undefined) return { kind: 'rejected', reason: 'consumed-or-missing' };
			if (current.expiresAtMs <= now()) {
				transactions.delete(id);
				return { kind: 'rejected', reason: 'expired' };
			}
			if (current.kind !== 'authorizing-application')
				return { kind: 'rejected', reason: 'wrong-state' };
			if (
				!sameOAuthBrowserSession(
					current.identity,
					oauthBrowserSessionIdentitySchema.parse(input.identity),
				)
			)
				return { kind: 'rejected', reason: 'identity-mismatch' };
			if (!oauthBrowserSecretsEqual(current.browserBindingSecret, input.browserBindingSecret))
				return { kind: 'rejected', reason: 'browser-binding-mismatch' };
			if (current.redirectUri !== input.redirectUri)
				return { kind: 'rejected', reason: 'invalid-redirect' };
			if (!oauthBrowserSecretsEqual(current.oauthState, input.oauthState))
				return { kind: 'rejected', reason: 'invalid-state' };
			const consuming = oauthConsumingTransactionSchema.parse({
				...current,
				kind: 'consuming-callback',
			});
			transactions.set(id, consuming);
			return { kind: 'accepted', transaction: consuming };
		},
		completeCallback: (input) => {
			const id = oauthTransactionIdSchema.parse(input.transactionId);
			const current = transactions.get(id);
			if (current?.kind !== 'consuming-callback')
				throw new Error('OAuth callback is not consuming.');
			if (current.expiresAtMs <= now()) {
				transactions.delete(id);
				throw new Error('OAuth transaction expired during exchange.');
			}
			if (completionSessions.size >= maxCompletionSessions) return { kind: 'capacity-exhausted' };
			const providerGrant = props.providerGrantSchema.parse(input.providerGrant);
			const createdAtMs = now();
			const completionSessionId = oauthCompletionSessionIdSchema.parse(
				createOAuthOpaqueIdentifier(),
			);
			const common = oauthCompletionCommonSchema.parse({
				...oauthCeremonyCommonSchema.strip().parse(current),
				applicationId: current.applicationId,
				completedApplications: current.completedApplications,
				confirmedScopes: current.confirmedScopes,
				confirmedSelections: current.confirmedSelections,
				identity: current.identity,
				remainingApplications: current.remainingApplications,
				browserBindingSecret: createOAuthOpaqueIdentifier(),
				completionSessionId,
				createdAtMs,
				csrfSecret: createOAuthOpaqueIdentifier(),
				expiresAtMs: createdAtMs + completionSessionTtlMs,
			});
			const session = { ...common, kind: 'awaiting-account-confirmation' as const, providerGrant };
			transactions.delete(id);
			completionSessions.set(completionSessionId, session);
			completionIdsByTransaction.set(id, completionSessionId);
			return { kind: 'created', session };
		},
		beginCompletionCommit: (input) => {
			const id = oauthCompletionSessionIdSchema.parse(input.completionSessionId);
			const current = completionSessions.get(id);
			if (current === undefined) return { kind: 'rejected', reason: 'consumed-or-missing' };
			if (current.expiresAtMs <= now()) {
				discardCompletion(id);
				return { kind: 'rejected', reason: 'expired' };
			}
			if (current.kind !== 'awaiting-account-confirmation')
				return { kind: 'rejected', reason: 'wrong-state' };
			const failure = browserDecisionFailure(current, input);
			if (failure !== undefined) return { kind: 'rejected', reason: failure };
			const session = { ...current, kind: 'committing' as const };
			completionSessions.set(id, session);
			return { kind: 'accepted', session };
		},
		beginDisconnectCommit: (input) => {
			const id = oauthTransactionIdSchema.parse(input.transactionId);
			const current = transactions.get(id);
			if (current?.kind !== 'selecting-permissions' || current.target.kind !== 'disconnect')
				return { kind: 'rejected', reason: 'wrong-state' };
			if (current.expiresAtMs <= now()) {
				transactions.delete(id);
				return { kind: 'rejected', reason: 'expired' };
			}
			const failure = browserDecisionFailure(current, input);
			if (failure !== undefined) return { kind: 'rejected', reason: failure };
			const transaction = oauthCommittingDisconnectSchema.parse({
				...current,
				kind: 'committing-disconnect',
			});
			transactions.set(id, transaction);
			return { kind: 'accepted', transaction };
		},
		cancelPendingTransaction: (input) => cancel(input, true),
		cancelTransaction: (input) => cancel(input, false),
		cancelCompletion: (input) => {
			const id = oauthCompletionSessionIdSchema.parse(input.completionSessionId);
			const current = completionSessions.get(id);
			if (current === undefined) return undefined;
			if (current.expiresAtMs <= now()) {
				discardCompletion(id);
				return undefined;
			}
			if (
				current.kind !== 'awaiting-account-confirmation' ||
				browserDecisionFailure(current, input) !== undefined
			)
				return undefined;
			const context = oauthCeremonyContextSchema.strip().parse(current);
			discardCompletion(id);
			return context;
		},
		cancelBrowserCeremonies: (identity) => {
			let count = 0;
			for (const [id, transaction] of transactions) {
				if (
					transaction.kind !== 'committing-disconnect' &&
					transaction.identity !== undefined &&
					sameOAuthBrowserSession(transaction.identity, identity)
				) {
					transactions.delete(id);
					count++;
				}
			}
			for (const [id, session] of completionSessions) {
				if (session.kind !== 'committing' && sameOAuthBrowserSession(session.identity, identity)) {
					discardCompletion(id);
					count++;
				}
			}
			return count;
		},
		getCeremonyContext: (transactionId) => {
			const id = oauthTransactionIdSchema.parse(transactionId);
			const transaction = transactions.get(id);
			if (transaction !== undefined) return oauthCeremonyContextSchema.strip().parse(transaction);
			const completionId = completionIdsByTransaction.get(id);
			const completion =
				completionId === undefined ? undefined : completionSessions.get(completionId);
			return completion === undefined
				? undefined
				: oauthCeremonyContextSchema.strip().parse(completion);
		},
		getTransaction: (id) => transactions.get(oauthTransactionIdSchema.parse(id)),
		getCompletionSession: (id) => completionSessions.get(oauthCompletionSessionIdSchema.parse(id)),
		finishCompletion: discardCompletion,
		finishDisconnect: (transactionId) => {
			const id = oauthTransactionIdSchema.parse(transactionId);
			if (transactions.get(id)?.kind !== 'committing-disconnect') return false;
			return transactions.delete(id);
		},
		invalidateAll: () => {
			transactions.clear();
			for (const id of completionSessions.keys()) discardCompletion(id);
		},
		reapExpired,
	};
}
