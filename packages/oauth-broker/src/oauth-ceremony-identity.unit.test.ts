import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createOAuthTransactionStore } from './oauth-transaction-store.js';

const applicationId = oauthApplicationIdSchema.parse('gmail-app');
const identity = {
	issuer: 'https://identity.example.test',
	userId: 'test-owner',
	sessionId: 'test-session',
};
const providerGrantSchema = z.object({ accessToken: z.string() }).strict();

describe('OAuth ceremony human and initiator binding', () => {
	it('claims local disconnect once without creating a Google callback or provider grant', () => {
		// Arrange
		const store = createOAuthTransactionStore({ providerGrantSchema });
		const transaction = store.createTransaction({
			agentId: 'sun',
			applicationIds: [applicationId],
			configRevision: 'test-config',
			initiator: { kind: 'agent', agentId: 'sun' },
			target: {
				kind: 'disconnect',
				applicationId,
				accountId: '11111111-1111-4111-8111-111111111111',
				authorizationId: '22222222-2222-4222-8222-222222222222',
				generation: 1,
				authorizationMetadataRevision: 1,
				providerSubject: 'test-subject',
			},
		});
		store.bindBrowserIdentity({ identity, transactionId: transaction.transactionId });
		const decision = {
			identity,
			transactionId: transaction.transactionId,
			browserBindingSecret: transaction.browserBindingSecret,
			csrfToken: transaction.csrfSecret,
		};

		// Act / Assert
		expect(store.beginDisconnectCommit({ ...decision, csrfToken: 'incorrect-csrf' }).kind).toBe(
			'rejected',
		);
		expect(store.beginDisconnectCommit(decision).kind).toBe('accepted');
		expect(store.beginDisconnectCommit(decision).kind).toBe('rejected');
		expect(store.finishDisconnect(transaction.transactionId)).toBe(true);
		expect(store.getTransaction(transaction.transactionId)).toBeUndefined();
	});

	it('cancels only the switched browser session and rejects exchanges completed after expiry', () => {
		// Arrange
		let now = 1_000;
		const store = createOAuthTransactionStore({
			providerGrantSchema,
			now: () => now,
			transactionTtlMs: 100,
		});
		const first = store.createTransaction({
			agentId: 'sun',
			applicationIds: [applicationId],
			configRevision: 'test-config',
			initiator: { kind: 'agent', agentId: 'sun' },
			target: { kind: 'enroll', applicationId },
		});
		const second = store.createTransaction({
			agentId: 'sun',
			applicationIds: [applicationId],
			configRevision: 'test-config',
			initiator: { kind: 'agent', agentId: 'sun' },
			target: { kind: 'enroll', applicationId },
		});
		store.bindBrowserIdentity({ identity, transactionId: first.transactionId });
		const otherSession = { ...identity, sessionId: 'another-session' };
		store.bindBrowserIdentity({ identity: otherSession, transactionId: second.transactionId });

		// Act / Assert
		expect(store.cancelBrowserCeremonies(identity)).toBe(1);
		expect(store.getTransaction(second.transactionId)).toBeDefined();
		const authorizing = store.beginApplicationAuthorization({
			applicationId,
			completedApplications: [],
			confirmedSelections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] }),
			confirmedScopes: [oauthScopeSchema.parse('gmail.readonly')],
			redirectUri: 'https://auth.example.test/callback',
			remainingApplications: [],
			transactionId: second.transactionId,
		});
		expect(
			store.beginCallbackConsumption({
				identity: otherSession,
				transactionId: second.transactionId,
				browserBindingSecret: authorizing.browserBindingSecret,
				oauthState: authorizing.oauthState,
				redirectUri: authorizing.redirectUri,
			}).kind,
		).toBe('accepted');
		now = 1_101;
		expect(() =>
			store.completeCallback({
				providerGrant: { accessToken: 'synthetic-token' },
				transactionId: second.transactionId,
			}),
		).toThrow('expired during exchange');
	});

	it('binds the exact Clerk session through callback and one-use confirmation', () => {
		// Arrange
		const store = createOAuthTransactionStore({ providerGrantSchema, now: () => 1_000 });
		const transaction = store.createTransaction({
			agentId: 'sun',
			applicationIds: [applicationId],
			configRevision: 'test-config',
			initiator: { kind: 'agent', agentId: 'sun' },
			target: { kind: 'enroll', applicationId },
		});
		store.bindBrowserIdentity({ identity, transactionId: transaction.transactionId });
		const authorizing = store.beginApplicationAuthorization({
			applicationId,
			completedApplications: [],
			confirmedSelections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] }),
			confirmedScopes: [oauthScopeSchema.parse('gmail.readonly')],
			redirectUri: 'https://auth.example.test/callback',
			remainingApplications: [],
			transactionId: transaction.transactionId,
		});
		const callback = {
			browserBindingSecret: authorizing.browserBindingSecret,
			identity,
			oauthState: authorizing.oauthState,
			redirectUri: authorizing.redirectUri,
			transactionId: transaction.transactionId,
		};

		// Act / Assert
		expect(
			store.beginCallbackConsumption({
				...callback,
				identity: { ...identity, sessionId: 'another-session' },
			}),
		).toEqual({ kind: 'rejected', reason: 'identity-mismatch' });
		expect(store.beginCallbackConsumption(callback).kind).toBe('accepted');
		expect(store.beginCallbackConsumption(callback).kind).toBe('rejected');
		const completion = store.completeCallback({
			providerGrant: { accessToken: 'synthetic-token' },
			transactionId: transaction.transactionId,
		});
		if (completion.kind !== 'created') throw new Error('Expected confirmation.');
		expect(completion.session.identity).toEqual(identity);
		const confirmation = {
			browserBindingSecret: completion.session.browserBindingSecret,
			completionSessionId: completion.session.completionSessionId,
			csrfToken: completion.session.csrfSecret,
			identity,
		};
		expect(store.beginCompletionCommit(confirmation).kind).toBe('accepted');
		expect(store.beginCompletionCommit(confirmation).kind).toBe('rejected');
	});

	it('does not let an agent cancel an owner-initiated ceremony', () => {
		// Arrange
		const store = createOAuthTransactionStore({ providerGrantSchema });
		const transaction = store.createTransaction({
			agentId: 'ember',
			applicationIds: [applicationId],
			configRevision: 'test-config',
			initiator: {
				kind: 'website_owner',
				ownerIdentity: { issuer: identity.issuer, userId: identity.userId },
			},
			target: { kind: 'enroll', applicationId },
		});

		// Act / Assert
		expect(
			store.cancelPendingTransaction({
				agentId: 'ember',
				transactionId: transaction.transactionId,
			}),
		).toBe(false);
		expect(store.getTransaction(transaction.transactionId)).toBeDefined();
		expect(() =>
			store.bindBrowserIdentity({
				identity: { ...identity, userId: 'another-owner' },
				transactionId: transaction.transactionId,
			}),
		).toThrow();
	});
});
