import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	createOAuthTransactionStore,
	type OAuthCallbackCompletionResult,
	type OAuthCeremonyTransaction,
	type OAuthCompletionSession,
	type OAuthTransactionStore,
} from './oauth-transaction-store.js';

const providerGrantSchema = z
	.object({
		accessToken: z.string().min(1),
		providerSubject: z.string().min(1),
		refreshToken: z.string().min(1),
	})
	.strict();

type ProviderGrant = z.infer<typeof providerGrantSchema>;

function requireCreatedCompletion(
	result: OAuthCallbackCompletionResult<ProviderGrant>,
): Extract<
	OAuthCompletionSession<ProviderGrant>,
	{ readonly kind: 'awaiting-account-confirmation' }
> {
	if (result.kind !== 'created') throw new Error('Expected an OAuth completion session.');
	return result.session;
}

function createAuthorizingTransaction(
	now: () => number,
	existingStore?: OAuthTransactionStore<ProviderGrant>,
): {
	readonly authorizing: Extract<
		OAuthCeremonyTransaction,
		{ readonly kind: 'authorizing-application' }
	>;
	readonly store: OAuthTransactionStore<ProviderGrant>;
	readonly transaction: Extract<
		OAuthCeremonyTransaction,
		{ readonly kind: 'selecting-permissions' }
	>;
} {
	const store = existingStore ?? createOAuthTransactionStore({ now, providerGrantSchema });
	const transaction = store.createTransaction({
		accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
		agentId: 'hermes',
		applicationIds: [oauthApplicationIdSchema.parse('gmail-app')],
		authorizationMode: 'enroll-missing',
		suggestedSelections: oauthPermissionSelectionsSchema.parse({
			'gmail-app': { gmail: 'read' },
		}),
	});
	const boundTransaction = store.bindTailnetIdentity({
		tailnetLogin: 'human@example.test',
		transactionId: transaction.transactionId,
	});
	const authorizing = store.beginApplicationAuthorization({
		applicationId: oauthApplicationIdSchema.parse('gmail-app'),
		completedApplications: [],
		confirmedSelections: oauthPermissionSelectionsSchema.parse({
			'gmail-app': { gmail: 'read' },
		}),
		confirmedScopes: [oauthScopeSchema.parse('gmail.readonly')],
		redirectUri: 'https://auth.claw.askluna.xyz:18900/oauth/google/callback',
		remainingApplications: [],
		transactionId: boundTransaction.transactionId,
	});
	return { authorizing, store, transaction: boundTransaction };
}

describe('OAuth transaction store', () => {
	it('atomically admits one matching callback and rejects the duplicate', () => {
		const { authorizing, store, transaction } = createAuthorizingTransaction(() => 1_000);
		const callback = {
			oauthState: authorizing.oauthState,
			redirectUri: authorizing.redirectUri,
			tailnetLogin: authorizing.tailnetLogin,
			transactionId: transaction.transactionId,
		};
		const first = store.beginCallbackConsumption(callback);
		expect(first).toMatchObject({ kind: 'accepted' });
		expect(store.beginCallbackConsumption(callback)).toEqual({
			kind: 'rejected',
			reason: 'wrong-state',
		});
	});

	it.each([
		['identity', { tailnetLogin: 'other@example.test' }, 'identity-mismatch'],
		['state', { oauthState: 'z'.repeat(43) }, 'invalid-state'],
		[
			'redirect',
			{ redirectUri: 'https://auth.claw.askluna.xyz/oauth/google/other' },
			'invalid-redirect',
		],
	] as const)('fails closed on callback %s mismatch', (_caseName, override, reason) => {
		const { authorizing, store, transaction } = createAuthorizingTransaction(() => 1_000);
		expect(
			store.beginCallbackConsumption({
				oauthState: authorizing.oauthState,
				redirectUri: authorizing.redirectUri,
				tailnetLogin: authorizing.tailnetLogin,
				transactionId: transaction.transactionId,
				...override,
			}),
		).toEqual({ kind: 'rejected', reason });
	});

	it('rotates to a distinct completion session and atomically admits one commit', () => {
		const { authorizing, store, transaction } = createAuthorizingTransaction(() => 1_000);
		expect(
			store.beginCallbackConsumption({
				oauthState: authorizing.oauthState,
				redirectUri: authorizing.redirectUri,
				tailnetLogin: authorizing.tailnetLogin,
				transactionId: transaction.transactionId,
			}),
		).toMatchObject({ kind: 'accepted' });
		const completion = requireCreatedCompletion(
			store.completeCallback({
				providerGrant: {
					accessToken: 'sensitive-access',
					providerSubject: 'google-subject-1',
					refreshToken: 'sensitive-refresh',
				},
				transactionId: transaction.transactionId,
			}),
		);
		expect(completion.completionSessionId).not.toBe(transaction.transactionId);
		expect(store.getTransaction(transaction.transactionId)).toBeUndefined();
		expect(
			store.beginCompletionCommit({
				browserBindingSecret: completion.browserBindingSecret,
				completionSessionId: completion.completionSessionId,
				csrfToken: completion.csrfSecret,
				tailnetLogin: completion.tailnetLogin,
			}),
		).toMatchObject({ kind: 'accepted', session: { kind: 'committing' } });
		expect(
			store.beginCompletionCommit({
				browserBindingSecret: completion.browserBindingSecret,
				completionSessionId: completion.completionSessionId,
				csrfToken: completion.csrfSecret,
				tailnetLogin: completion.tailnetLogin,
			}),
		).toEqual({ kind: 'rejected', reason: 'wrong-state' });
	});

	it('keeps the original ceremony identity cancellable after completion-session rotation', () => {
		const { authorizing, store, transaction } = createAuthorizingTransaction(() => 1_000);
		store.beginCallbackConsumption({
			oauthState: authorizing.oauthState,
			redirectUri: authorizing.redirectUri,
			tailnetLogin: authorizing.tailnetLogin,
			transactionId: transaction.transactionId,
		});
		const completion = requireCreatedCompletion(
			store.completeCallback({
				providerGrant: {
					accessToken: 'sensitive-access',
					providerSubject: 'google-subject-1',
					refreshToken: 'sensitive-refresh',
				},
				transactionId: transaction.transactionId,
			}),
		);

		expect(store.getCeremonyOwner(transaction.transactionId)).toMatchObject({
			agentId: 'hermes',
			transactionId: transaction.transactionId,
		});
		expect(
			store.cancelTransaction({ agentId: 'hermes', transactionId: transaction.transactionId }),
		).toBe(true);
		expect(store.getCeremonyOwner(transaction.transactionId)).toBeUndefined();
		expect(
			store.beginCompletionCommit({
				browserBindingSecret: completion.browserBindingSecret,
				completionSessionId: completion.completionSessionId,
				csrfToken: completion.csrfSecret,
				tailnetLogin: completion.tailnetLogin,
			}),
		).toEqual({ kind: 'rejected', reason: 'consumed-or-missing' });
	});

	it('cancels an account-confirmation session only with its bound browser authority', () => {
		const { authorizing, store, transaction } = createAuthorizingTransaction(() => 1_000);
		store.beginCallbackConsumption({
			oauthState: authorizing.oauthState,
			redirectUri: authorizing.redirectUri,
			tailnetLogin: authorizing.tailnetLogin,
			transactionId: transaction.transactionId,
		});
		const completion = requireCreatedCompletion(
			store.completeCallback({
				providerGrant: {
					accessToken: 'sensitive-access',
					providerSubject: 'google-subject-1',
					refreshToken: 'sensitive-refresh',
				},
				transactionId: transaction.transactionId,
			}),
		);

		expect(
			store.cancelCompletion({
				browserBindingSecret: completion.browserBindingSecret,
				completionSessionId: completion.completionSessionId,
				csrfToken: 'x'.repeat(43),
				tailnetLogin: completion.tailnetLogin,
			}),
		).toBeUndefined();
		expect(
			store.cancelCompletion({
				browserBindingSecret: completion.browserBindingSecret,
				completionSessionId: completion.completionSessionId,
				csrfToken: completion.csrfSecret,
				tailnetLogin: completion.tailnetLogin,
			}),
		).toMatchObject({ transactionId: transaction.transactionId });
		expect(store.getCeremonyOwner(transaction.transactionId)).toBeUndefined();
	});

	it('invalidates restart-local authority and discards sensitive completion grants', () => {
		const discard = vi.fn();
		const { authorizing, transaction } = createAuthorizingTransaction(() => 1_000);
		const store = createOAuthTransactionStore({
			now: () => 1_000,
			onDiscardProviderGrant: discard,
			providerGrantSchema,
		});
		const replacementTransaction = store.createTransaction({
			accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
			agentId: 'hermes',
			applicationIds: [oauthApplicationIdSchema.parse('gmail-app')],
			authorizationMode: 'enroll-missing',
		});
		const boundReplacementTransaction = store.bindTailnetIdentity({
			tailnetLogin: 'human@example.test',
			transactionId: replacementTransaction.transactionId,
		});
		const replacementAuthorizing = store.beginApplicationAuthorization({
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			completedApplications: [],
			confirmedSelections: oauthPermissionSelectionsSchema.parse({
				'gmail-app': { gmail: 'read' },
			}),
			confirmedScopes: [oauthScopeSchema.parse('gmail.readonly')],
			redirectUri: authorizing.redirectUri,
			remainingApplications: [],
			transactionId: boundReplacementTransaction.transactionId,
		});
		store.beginCallbackConsumption({
			oauthState: replacementAuthorizing.oauthState,
			redirectUri: replacementAuthorizing.redirectUri,
			tailnetLogin: replacementAuthorizing.tailnetLogin,
			transactionId: replacementTransaction.transactionId,
		});
		store.completeCallback({
			providerGrant: {
				accessToken: 'sensitive-access',
				providerSubject: 'google-subject-1',
				refreshToken: 'sensitive-refresh',
			},
			transactionId: replacementTransaction.transactionId,
		});

		store.invalidateAll();
		expect(discard).toHaveBeenCalledOnce();
		expect(store.getTransaction(transaction.transactionId)).toBeUndefined();
	});

	it('preserves the consuming transaction when completion-session capacity is exhausted', () => {
		const store = createOAuthTransactionStore({
			maxCompletionSessions: 1,
			now: () => 1_000,
			providerGrantSchema,
		});
		const first = createAuthorizingTransaction(() => 1_000, store);
		store.beginCallbackConsumption({
			oauthState: first.authorizing.oauthState,
			redirectUri: first.authorizing.redirectUri,
			tailnetLogin: first.authorizing.tailnetLogin,
			transactionId: first.transaction.transactionId,
		});
		const firstCompletion = requireCreatedCompletion(
			store.completeCallback({
				providerGrant: {
					accessToken: 'first-sensitive-access',
					providerSubject: 'google-subject-1',
					refreshToken: 'first-sensitive-refresh',
				},
				transactionId: first.transaction.transactionId,
			}),
		);
		const second = createAuthorizingTransaction(() => 1_000, store);
		store.beginCallbackConsumption({
			oauthState: second.authorizing.oauthState,
			redirectUri: second.authorizing.redirectUri,
			tailnetLogin: second.authorizing.tailnetLogin,
			transactionId: second.transaction.transactionId,
		});

		expect(
			store.completeCallback({
				providerGrant: {
					accessToken: 'second-sensitive-access',
					providerSubject: 'google-subject-1',
					refreshToken: 'second-sensitive-refresh',
				},
				transactionId: second.transaction.transactionId,
			}),
		).toEqual({ kind: 'capacity-exhausted' });
		expect(store.getTransaction(second.transaction.transactionId)).toMatchObject({
			kind: 'consuming-callback',
		});
		expect(store.finishCompletion(firstCompletion.completionSessionId)).toBe(true);
		expect(
			requireCreatedCompletion(
				store.completeCallback({
					providerGrant: {
						accessToken: 'second-sensitive-access',
						providerSubject: 'google-subject-1',
						refreshToken: 'second-sensitive-refresh',
					},
					transactionId: second.transaction.transactionId,
				}),
			),
		).toMatchObject({ transactionId: second.transaction.transactionId });
	});

	it('expires pending and completion state using the injected clock', () => {
		let nowMs = 1_000;
		const { authorizing, store, transaction } = createAuthorizingTransaction(() => nowMs);
		nowMs = 1_000 + 10 * 60_000;
		expect(
			store.beginCallbackConsumption({
				oauthState: authorizing.oauthState,
				redirectUri: authorizing.redirectUri,
				tailnetLogin: authorizing.tailnetLogin,
				transactionId: transaction.transactionId,
			}),
		).toEqual({ kind: 'rejected', reason: 'expired' });
	});
});
