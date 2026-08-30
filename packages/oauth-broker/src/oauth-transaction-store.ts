import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthCompletionSessionIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	oauthTransactionIdSchema,
	type OAuthAccountProfileId,
	type OAuthApplicationId,
	type OAuthCompletionSessionId,
	type OAuthPermissionSelections,
	type OAuthScope,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

const oauthOpaqueBrowserSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const oauthAgentIdSchema = z.string().min(1).max(128);
const tailnetLoginSchema = z.string().min(1).max(320);
const oauthRedirectUriSchema = z.url().refine((value) => value.startsWith('https://'), {
	message: 'OAuth redirect URIs must use HTTPS.',
});

interface OAuthTransactionCommon {
	readonly accountProfileId: OAuthAccountProfileId;
	readonly agentId: string;
	readonly applicationIds: readonly OAuthApplicationId[];
	readonly browserBindingSecret: string;
	readonly createdAtMs: number;
	readonly csrfSecret: string;
	readonly expiresAtMs: number;
	readonly suggestedSelections?: OAuthPermissionSelections | undefined;
	readonly transactionId: OAuthTransactionId;
}

export type OAuthCeremonyTransaction =
	| (OAuthTransactionCommon & {
			readonly kind: 'selecting-permissions';
			readonly tailnetLogin?: string | undefined;
	  })
	| (OAuthTransactionCommon & {
			readonly applicationId: OAuthApplicationId;
			readonly completedApplications: readonly OAuthApplicationId[];
			readonly confirmedSelections: OAuthPermissionSelections;
			readonly confirmedScopes: readonly OAuthScope[];
			readonly kind: 'authorizing-application';
			readonly oauthState: string;
			readonly pkceChallenge: string;
			readonly pkceVerifier: string;
			readonly redirectUri: string;
			readonly remainingApplications: readonly OAuthApplicationId[];
			readonly tailnetLogin: string;
	  })
	| (OAuthTransactionCommon & {
			readonly applicationId: OAuthApplicationId;
			readonly completedApplications: readonly OAuthApplicationId[];
			readonly confirmedSelections: OAuthPermissionSelections;
			readonly confirmedScopes: readonly OAuthScope[];
			readonly kind: 'consuming-callback';
			readonly oauthState: string;
			readonly pkceChallenge: string;
			readonly pkceVerifier: string;
			readonly redirectUri: string;
			readonly remainingApplications: readonly OAuthApplicationId[];
			readonly tailnetLogin: string;
	  });

interface OAuthCompletionSessionCommon {
	readonly accountProfileId: OAuthAccountProfileId;
	readonly agentId: string;
	readonly applicationId: OAuthApplicationId;
	readonly browserBindingSecret: string;
	readonly completedApplications: readonly OAuthApplicationId[];
	readonly confirmedSelections: OAuthPermissionSelections;
	readonly completionSessionId: OAuthCompletionSessionId;
	readonly createdAtMs: number;
	readonly csrfSecret: string;
	readonly expiresAtMs: number;
	readonly remainingApplications: readonly OAuthApplicationId[];
	readonly tailnetLogin: string;
}

export type OAuthCompletionSession<TProviderGrant> =
	| (OAuthCompletionSessionCommon & {
			readonly kind: 'awaiting-account-confirmation';
			readonly providerGrant: TProviderGrant;
	  })
	| (OAuthCompletionSessionCommon & {
			readonly kind: 'committing';
			readonly providerGrant: TProviderGrant;
	  });

export type OAuthCallbackConsumptionResult =
	| {
			readonly kind: 'accepted';
			readonly transaction: Extract<
				OAuthCeremonyTransaction,
				{ readonly kind: 'consuming-callback' }
			>;
	  }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'consumed-or-missing'
				| 'expired'
				| 'identity-mismatch'
				| 'invalid-state'
				| 'invalid-redirect'
				| 'wrong-state';
	  };

export type OAuthCompletionCommitResult<TProviderGrant> =
	| {
			readonly kind: 'accepted';
			readonly session: Extract<
				OAuthCompletionSession<TProviderGrant>,
				{ readonly kind: 'committing' }
			>;
	  }
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'browser-binding-mismatch'
				| 'consumed-or-missing'
				| 'csrf-mismatch'
				| 'expired'
				| 'identity-mismatch'
				| 'wrong-state';
	  };

export interface OAuthTransactionStore<TProviderGrant> {
	bindTailnetIdentity(props: {
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): Extract<OAuthCeremonyTransaction, { readonly kind: 'selecting-permissions' }>;
	beginApplicationAuthorization(props: {
		readonly applicationId: OAuthApplicationId;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly confirmedSelections: OAuthPermissionSelections;
		readonly confirmedScopes: readonly OAuthScope[];
		readonly redirectUri: string;
		readonly remainingApplications: readonly OAuthApplicationId[];
		readonly transactionId: OAuthTransactionId;
	}): Extract<OAuthCeremonyTransaction, { readonly kind: 'authorizing-application' }>;
	beginCallbackConsumption(props: {
		readonly oauthState: string;
		readonly redirectUri: string;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): OAuthCallbackConsumptionResult;
	beginCompletionCommit(props: {
		readonly browserBindingSecret: string;
		readonly completionSessionId: OAuthCompletionSessionId;
		readonly csrfToken: string;
		readonly tailnetLogin: string;
	}): OAuthCompletionCommitResult<TProviderGrant>;
	cancelTransaction(props: {
		readonly agentId: string;
		readonly transactionId: OAuthTransactionId;
	}): boolean;
	completeCallback(props: {
		readonly providerGrant: TProviderGrant;
		readonly transactionId: OAuthTransactionId;
	}): Extract<
		OAuthCompletionSession<TProviderGrant>,
		{ readonly kind: 'awaiting-account-confirmation' }
	>;
	createTransaction(props: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationIds: readonly OAuthApplicationId[];
		readonly suggestedSelections?: OAuthPermissionSelections | undefined;
	}): Extract<OAuthCeremonyTransaction, { readonly kind: 'selecting-permissions' }>;
	finishCompletion(completionSessionId: OAuthCompletionSessionId): boolean;
	getTransaction(transactionId: OAuthTransactionId): OAuthCeremonyTransaction | undefined;
	invalidateAll(): void;
	reapExpired(): { readonly completionSessionCount: number; readonly transactionCount: number };
}

function createOpaqueIdentifier(): string {
	return randomBytes(32).toString('base64url');
}

function createPkcePair(): { readonly challenge: string; readonly verifier: string } {
	const verifier = createOpaqueIdentifier();
	return {
		challenge: createHash('sha256').update(verifier).digest('base64url'),
		verifier,
	};
}

function opaqueSecretsEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function validateUniqueApplications(
	applications: readonly OAuthApplicationId[],
	fieldName: string,
): readonly OAuthApplicationId[] {
	const parsed = z.array(oauthApplicationIdSchema).readonly().parse(applications);
	if (new Set(parsed).size !== parsed.length) {
		throw new Error(`${fieldName} must contain unique OAuth application IDs.`);
	}
	return parsed;
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
	for (const [fieldName, value] of [
		['transactionTtlMs', transactionTtlMs],
		['completionSessionTtlMs', completionSessionTtlMs],
		['maxTransactions', maxTransactions],
		['maxCompletionSessions', maxCompletionSessions],
	] as const) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`${fieldName} must be a positive safe integer.`);
		}
	}
	const transactions = new Map<OAuthTransactionId, OAuthCeremonyTransaction>();
	const completionSessions = new Map<
		OAuthCompletionSessionId,
		OAuthCompletionSession<TProviderGrant>
	>();

	const discardCompletionSession = (completionSessionId: OAuthCompletionSessionId): boolean => {
		const session = completionSessions.get(completionSessionId);
		if (session === undefined) return false;
		completionSessions.delete(completionSessionId);
		props.onDiscardProviderGrant?.(session.providerGrant);
		return true;
	};

	const reapExpired = (): {
		readonly completionSessionCount: number;
		readonly transactionCount: number;
	} => {
		const currentTimeMs = now();
		let transactionCount = 0;
		let completionSessionCount = 0;
		for (const [transactionId, transaction] of transactions) {
			if (transaction.expiresAtMs > currentTimeMs) continue;
			transactions.delete(transactionId);
			transactionCount += 1;
		}
		for (const [completionSessionId, completionSession] of completionSessions) {
			if (completionSession.expiresAtMs > currentTimeMs) continue;
			discardCompletionSession(completionSessionId);
			completionSessionCount += 1;
		}
		return { completionSessionCount, transactionCount };
	};

	return {
		bindTailnetIdentity: ({ tailnetLogin, transactionId }) => {
			const parsedTransactionId = oauthTransactionIdSchema.parse(transactionId);
			const current = transactions.get(parsedTransactionId);
			if (current?.kind !== 'selecting-permissions') {
				throw new Error('OAuth transaction is not available for browser identity binding.');
			}
			if (current.expiresAtMs <= now()) {
				transactions.delete(parsedTransactionId);
				throw new Error('OAuth transaction expired.');
			}
			const parsedTailnetLogin = tailnetLoginSchema.parse(tailnetLogin);
			if (current.tailnetLogin !== undefined && current.tailnetLogin !== parsedTailnetLogin) {
				throw new Error('OAuth transaction is already bound to another tailnet identity.');
			}
			const bound = { ...current, tailnetLogin: parsedTailnetLogin };
			transactions.set(parsedTransactionId, bound);
			return bound;
		},
		beginApplicationAuthorization: (applicationProps) => {
			const transactionId = oauthTransactionIdSchema.parse(applicationProps.transactionId);
			const current = transactions.get(transactionId);
			if (current?.kind !== 'selecting-permissions') {
				throw new Error('OAuth transaction is not selecting permissions.');
			}
			if (current.expiresAtMs <= now()) {
				transactions.delete(transactionId);
				throw new Error('OAuth transaction expired.');
			}
			if (current.tailnetLogin === undefined) {
				throw new Error('OAuth transaction has no bound tailnet identity.');
			}
			const tailnetLogin = current.tailnetLogin;
			const pkce = createPkcePair();
			const next = {
				...current,
				applicationId: oauthApplicationIdSchema.parse(applicationProps.applicationId),
				completedApplications: validateUniqueApplications(
					applicationProps.completedApplications,
					'completedApplications',
				),
				confirmedSelections: oauthPermissionSelectionsSchema.parse(
					applicationProps.confirmedSelections,
				),
				confirmedScopes: z
					.array(oauthScopeSchema)
					.readonly()
					.parse(applicationProps.confirmedScopes),
				kind: 'authorizing-application' as const,
				oauthState: createOpaqueIdentifier(),
				pkceChallenge: pkce.challenge,
				pkceVerifier: pkce.verifier,
				redirectUri: oauthRedirectUriSchema.parse(applicationProps.redirectUri),
				remainingApplications: validateUniqueApplications(
					applicationProps.remainingApplications,
					'remainingApplications',
				),
				tailnetLogin,
			};
			transactions.set(transactionId, next);
			return next;
		},
		beginCallbackConsumption: (callbackProps) => {
			const transactionId = oauthTransactionIdSchema.parse(callbackProps.transactionId);
			const current = transactions.get(transactionId);
			if (current === undefined) return { kind: 'rejected', reason: 'consumed-or-missing' };
			if (current.expiresAtMs <= now()) {
				transactions.delete(transactionId);
				return { kind: 'rejected', reason: 'expired' };
			}
			if (current.kind !== 'authorizing-application') {
				return { kind: 'rejected', reason: 'wrong-state' };
			}
			if (current.tailnetLogin !== tailnetLoginSchema.parse(callbackProps.tailnetLogin)) {
				return { kind: 'rejected', reason: 'identity-mismatch' };
			}
			if (current.redirectUri !== oauthRedirectUriSchema.parse(callbackProps.redirectUri)) {
				return { kind: 'rejected', reason: 'invalid-redirect' };
			}
			if (current.oauthState !== oauthOpaqueBrowserSecretSchema.parse(callbackProps.oauthState)) {
				return { kind: 'rejected', reason: 'invalid-state' };
			}
			const consuming = { ...current, kind: 'consuming-callback' as const };
			transactions.set(transactionId, consuming);
			return { kind: 'accepted', transaction: consuming };
		},
		beginCompletionCommit: (completionProps) => {
			const completionSessionId = oauthCompletionSessionIdSchema.parse(
				completionProps.completionSessionId,
			);
			const current = completionSessions.get(completionSessionId);
			if (current === undefined) return { kind: 'rejected', reason: 'consumed-or-missing' };
			if (current.expiresAtMs <= now()) {
				discardCompletionSession(completionSessionId);
				return { kind: 'rejected', reason: 'expired' };
			}
			if (current.kind !== 'awaiting-account-confirmation') {
				return { kind: 'rejected', reason: 'wrong-state' };
			}
			if (current.tailnetLogin !== tailnetLoginSchema.parse(completionProps.tailnetLogin)) {
				return { kind: 'rejected', reason: 'identity-mismatch' };
			}
			if (
				!opaqueSecretsEqual(
					current.browserBindingSecret,
					oauthOpaqueBrowserSecretSchema.parse(completionProps.browserBindingSecret),
				)
			) {
				return { kind: 'rejected', reason: 'browser-binding-mismatch' };
			}
			if (
				!opaqueSecretsEqual(
					current.csrfSecret,
					oauthOpaqueBrowserSecretSchema.parse(completionProps.csrfToken),
				)
			) {
				return { kind: 'rejected', reason: 'csrf-mismatch' };
			}
			const committing = { ...current, kind: 'committing' as const };
			completionSessions.set(completionSessionId, committing);
			return { kind: 'accepted', session: committing };
		},
		cancelTransaction: ({ agentId, transactionId }) => {
			const parsedTransactionId = oauthTransactionIdSchema.parse(transactionId);
			const current = transactions.get(parsedTransactionId);
			if (current === undefined || current.agentId !== oauthAgentIdSchema.parse(agentId))
				return false;
			return transactions.delete(parsedTransactionId);
		},
		completeCallback: ({ providerGrant, transactionId }) => {
			const parsedTransactionId = oauthTransactionIdSchema.parse(transactionId);
			const current = transactions.get(parsedTransactionId);
			if (current?.kind !== 'consuming-callback') {
				throw new Error('OAuth callback transaction is not consuming.');
			}
			transactions.delete(parsedTransactionId);
			if (completionSessions.size >= maxCompletionSessions) {
				throw new Error('OAuth completion-session capacity is exhausted.');
			}
			const completionSessionId = oauthCompletionSessionIdSchema.parse(createOpaqueIdentifier());
			const createdAtMs = now();
			const completionSession = {
				accountProfileId: current.accountProfileId,
				agentId: current.agentId,
				applicationId: current.applicationId,
				browserBindingSecret: createOpaqueIdentifier(),
				completedApplications: current.completedApplications,
				confirmedSelections: current.confirmedSelections,
				completionSessionId,
				createdAtMs,
				csrfSecret: createOpaqueIdentifier(),
				expiresAtMs: createdAtMs + completionSessionTtlMs,
				kind: 'awaiting-account-confirmation' as const,
				providerGrant: props.providerGrantSchema.parse(providerGrant),
				remainingApplications: current.remainingApplications,
				tailnetLogin: current.tailnetLogin,
			};
			completionSessions.set(completionSessionId, completionSession);
			return completionSession;
		},
		createTransaction: (createProps) => {
			reapExpired();
			if (transactions.size >= maxTransactions) {
				throw new Error('OAuth transaction capacity is exhausted.');
			}
			const transactionId = oauthTransactionIdSchema.parse(createOpaqueIdentifier());
			const createdAtMs = now();
			const transaction = {
				accountProfileId: oauthAccountProfileIdSchema.parse(createProps.accountProfileId),
				agentId: oauthAgentIdSchema.parse(createProps.agentId),
				applicationIds: validateUniqueApplications(createProps.applicationIds, 'applicationIds'),
				browserBindingSecret: createOpaqueIdentifier(),
				createdAtMs,
				csrfSecret: createOpaqueIdentifier(),
				expiresAtMs: createdAtMs + transactionTtlMs,
				kind: 'selecting-permissions' as const,
				...(createProps.suggestedSelections === undefined
					? {}
					: {
							suggestedSelections: oauthPermissionSelectionsSchema.parse(
								createProps.suggestedSelections,
							),
						}),
				transactionId,
			};
			transactions.set(transactionId, transaction);
			return transaction;
		},
		finishCompletion: discardCompletionSession,
		getTransaction: (transactionId) =>
			transactions.get(oauthTransactionIdSchema.parse(transactionId)),
		invalidateAll: () => {
			transactions.clear();
			for (const completionSessionId of completionSessions.keys()) {
				discardCompletionSession(completionSessionId);
			}
		},
		reapExpired,
	};
}
