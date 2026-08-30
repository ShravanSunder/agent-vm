import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createOAuthTransactionStore } from './oauth-transaction-store.js';

const providerGrantSchema = z
	.object({
		accessToken: z.string().min(1),
		providerSubject: z.string().min(1),
		refreshToken: z.string().min(1),
	})
	.strict();

function createAuthorizingTransaction(now: () => number) {
	const store = createOAuthTransactionStore({ now, providerGrantSchema });
	const transaction = store.createTransaction({
		accountProfileId: oauthAccountProfileIdSchema.parse('personal-google'),
		agentId: 'hermes',
		suggestedSelections: oauthPermissionSelectionsSchema.parse({
			'gmail-app': { gmail: 'read' },
		}),
		tailnetLogin: 'human@example.test',
	});
	const authorizing = store.beginApplicationAuthorization({
		applicationId: oauthApplicationIdSchema.parse('gmail-app'),
		completedApplications: [],
		confirmedScopes: [oauthScopeSchema.parse('gmail.readonly')],
		redirectUri: 'https://auth.claw.askluna.xyz/oauth/google/callback',
		remainingApplications: [],
		transactionId: transaction.transactionId,
	});
	return { authorizing, store, transaction };
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
		const completion = store.completeCallback({
			providerGrant: {
				accessToken: 'sensitive-access',
				providerSubject: 'google-subject-1',
				refreshToken: 'sensitive-refresh',
			},
			transactionId: transaction.transactionId,
		});
		expect(completion.completionSessionId).not.toBe(transaction.transactionId);
		expect(store.getTransaction(transaction.transactionId)).toBeUndefined();
		expect(
			store.beginCompletionCommit({
				completionSessionId: completion.completionSessionId,
				tailnetLogin: completion.tailnetLogin,
			}),
		).toMatchObject({ kind: 'accepted', session: { kind: 'committing' } });
		expect(
			store.beginCompletionCommit({
				completionSessionId: completion.completionSessionId,
				tailnetLogin: completion.tailnetLogin,
			}),
		).toEqual({ kind: 'rejected', reason: 'wrong-state' });
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
			tailnetLogin: 'human@example.test',
		});
		const replacementAuthorizing = store.beginApplicationAuthorization({
			applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			completedApplications: [],
			confirmedScopes: [oauthScopeSchema.parse('gmail.readonly')],
			redirectUri: authorizing.redirectUri,
			remainingApplications: [],
			transactionId: replacementTransaction.transactionId,
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
