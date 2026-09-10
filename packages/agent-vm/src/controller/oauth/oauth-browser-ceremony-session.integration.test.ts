import { afterEach, describe, expect, it } from 'vitest';

import {
	createBrokerFacadeFixture,
	facadeIdentity,
	prepareBrokerConsent,
} from '../../../../oauth-broker/src/google/google-broker-facade-test-fixture.js';
import { createOAuthBrowserNavigationStore } from '../../../../oauth-broker/src/oauth-browser-navigation-store.js';
import { createOAuthLoginContinuationStore } from '../../../../oauth-broker/src/oauth-login-continuation-store.js';
import { createOAuthBrowserSessionRoutes } from './oauth-browser-session-routes.js';

describe('browser ceremony identity across real broker states', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
	});
	it('authenticates the callback state without reopening permission selection and rejects wrong bindings', async () => {
		// Arrange: real broker transactions, synthetic Google and Clerk boundaries.
		fixture = await createBrokerFacadeFixture();
		const prepared = await prepareBrokerConsent(fixture);
		const browser = createOAuthBrowserSessionRoutes({
			broker: fixture.broker,
			config: fixture.config,
			navigation: createOAuthBrowserNavigationStore(),
			continuations: createOAuthLoginContinuationStore(),
			cancelPolicyContexts: () => {},
			verifier: {
				verifyBootstrap: async () => ({
					kind: 'verified',
					identity: facadeIdentity,
					setCookies: [],
				}),
				verifyCurrentCookie: async () => ({ kind: 'not-current' }),
				verifySession: async (identity) => ({ kind: 'verified', identity }),
				revokeSession: async () => ({ kind: 'revoked' }),
				signInUrl: () => 'https://identity.example.test/sign-in',
			},
		});
		const request = (kind: 'transaction' | 'completion', id: string, secret: string): Request =>
			new Request('https://auth.example.test/oauth/google/callback', {
				headers: {
					cookie: `agent_vm_oauth_${kind}=${id}; agent_vm_oauth_${kind}_binding=${secret}`,
				},
			});
		const transaction = { kind: 'transaction' as const, id: prepared.redirect.transactionId };
		// Act / Assert
		await expect(
			browser.readIdentity(
				request('transaction', transaction.id, prepared.redirect.browserBindingSecret),
				transaction,
			),
		).resolves.toEqual({ kind: 'verified', identity: facadeIdentity });
		await expect(
			browser.readIdentity(request('transaction', transaction.id, 'wrong-binding'), transaction),
		).resolves.not.toMatchObject({ kind: 'verified' });
		const callback = await fixture.exchangeRedirect(prepared.redirect);
		if (callback.kind !== 'confirmation') throw new Error('Expected confirmation.');
		const completion = {
			kind: 'completion' as const,
			id: callback.confirmation.completionSessionId,
		};
		await expect(
			browser.readIdentity(
				request('completion', completion.id, callback.confirmation.browserBindingSecret),
				completion,
			),
		).resolves.toEqual({ kind: 'verified', identity: facadeIdentity });
		await expect(
			browser.readIdentity(request('completion', completion.id, 'wrong-binding'), completion),
		).resolves.not.toMatchObject({ kind: 'verified' });
	});
});
