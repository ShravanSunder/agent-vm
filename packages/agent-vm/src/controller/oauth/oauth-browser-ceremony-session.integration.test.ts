import { afterEach, describe, expect, it, vi } from 'vitest';

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
	it.each(['unconfigured', 'wrong-issuer', 'inaccessible-transaction'] as const)(
		'keeps admission explicit for %s',
		async (scenario) => {
			fixture = await createBrokerFacadeFixture();
			const identity = {
				...facadeIdentity,
				...(scenario === 'unconfigured' ? { userId: 'user_unconfigured' } : {}),
				...(scenario === 'wrong-issuer' ? { issuer: 'https://wrong.example.test' } : {}),
			};
			const navigation = createOAuthBrowserNavigationStore();
			const createNavigation = vi.spyOn(navigation, 'create');
			const beginAuthorization = vi.spyOn(fixture.broker, 'beginWebsiteAuthorization');
			const continuations = createOAuthLoginContinuationStore();
			const login = continuations.create(
				scenario === 'inaccessible-transaction'
					? {
							kind: 'authorization',
							transactionId: 'missing-transaction-111111111111111111111111111',
						}
					: { kind: 'agents' },
			);
			if (login.kind !== 'created') throw new Error('Expected login continuation.');
			const browser = createOAuthBrowserSessionRoutes({
				assets: {
					css: 'oauth.1111111111111111.css',
					javascript: 'oauth.2222222222222222.js',
					onboarding: 'onboarding.3333333333333333.js',
				},
				broker: fixture.broker,
				config: fixture.config,
				navigation,
				continuations,
				cancelPolicyContexts: () => {},
				verifier: {
					verifyBootstrap: async () => ({ kind: 'verified', identity, setCookies: [] }),
					verifyCurrentCookie: async () => ({ kind: 'not-current' }),
					verifySession: async () => ({ kind: 'verified', identity }),
					revokeSession: async () => ({ kind: 'revoked' }),
					verifyGoogleIdentity: async () => ({
						kind: 'verified',
						identity,
						emailAddress: 'unconfigured@example.test',
					}),
				},
			});
			const cookie = `agent_vm_oauth_login=${login.continuationId}; agent_vm_oauth_login_binding=${login.browserBindingSecret}`;
			const response = await browser.routes.request(
				`${fixture.config.browser.publicBaseUrl}/oauth/auth/return`,
				{ headers: { cookie } },
			);
			expect(response.status).toBe(403);
			const html = await response.text();
			if (scenario === 'unconfigured') {
				expect(html).toContain('Waiting for access');
				expect(html).toContain('unconfigured@example.test');
				expect(html).toContain('href="/oauth/auth/start"');
			} else {
				expect(html).not.toContain('Waiting for access');
				expect(html).not.toContain('unconfigured@example.test');
			}
			expect(html).not.toContain('<form');
			expect(html).not.toContain('<script');
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(createNavigation).not.toHaveBeenCalled();
			expect(beginAuthorization).not.toHaveBeenCalled();
			expect(
				response.headers
					.getSetCookie()
					.some((value) => value.startsWith('agent_vm_oauth_navigation=')),
			).toBe(false);
			expect(
				continuations.isActive({
					continuationId: login.continuationId,
					browserBindingSecret: login.browserBindingSecret,
				}),
			).toBe(false);
			// Once the operator configures this person, a fresh login rechecks access.
			if (scenario !== 'unconfigured') return;
			const owner = Object.values(fixture.config.owners)[0];
			if (owner === undefined) throw new Error('Expected configured owner fixture.');
			owner.clerkUserId = identity.userId;
			const retry = await browser.routes.request(
				`${fixture.config.browser.publicBaseUrl}/oauth/auth/start`,
			);
			expect(retry.status).toBe(303);
			expect(retry.headers.get('location')).toBe('/oauth/agents');
			expect(createNavigation).toHaveBeenCalledOnce();
			expect(beginAuthorization).not.toHaveBeenCalled();
		},
	);
	it('authenticates the callback state without reopening permission selection and rejects wrong bindings', async () => {
		// Arrange: real broker transactions, synthetic Google and Clerk boundaries.
		fixture = await createBrokerFacadeFixture();
		const prepared = await prepareBrokerConsent(fixture);
		const browser = createOAuthBrowserSessionRoutes({
			assets: {
				css: 'oauth.1111111111111111.css',
				javascript: 'oauth.2222222222222222.js',
				onboarding: 'onboarding.3333333333333333.js',
			},
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
				verifyGoogleIdentity: async (identity) => ({
					kind: 'verified',
					identity,
					emailAddress: 'member@example.test',
				}),
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
