import { generateKeyPairSync, sign } from 'node:crypto';

import { createOAuthLoginContinuationStore } from '@agent-vm/oauth-broker';
import { createClerkClient } from '@clerk/backend';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createClerkBrowserIdentityVerifier,
	type ClerkBrowserIdentityVerifier,
} from './clerk-browser-identity-verifier.js';
import { createClerkLoginRoutes } from './clerk-login-routes.js';

const identity = {
	issuer: 'https://clerk.example.test',
	userId: 'user_owner',
	sessionId: 'sess_owner',
};
const site = 'https://auth.example.test:18900';
const page = {
	websiteOrigin: site,
	issuer: identity.issuer,
	publishableKey: 'pk_test_Zml4dHVyZSQ=',
	assets: {
		css: 'oauth.1111111111111111.css',
		javascript: 'oauth.2222222222222222.js',
		onboarding: 'onboarding.3333333333333333.js',
	},
};

afterEach(() => vi.unstubAllGlobals());

function fixture(): {
	readonly app: ReturnType<typeof createClerkLoginRoutes>;
	readonly verifier: ClerkBrowserIdentityVerifier;
	readonly bound: { target: unknown; identity: unknown }[];
	readonly continuations: ReturnType<typeof createOAuthLoginContinuationStore>;
} {
	const continuations = createOAuthLoginContinuationStore();
	const bound: { target: unknown; identity: unknown }[] = [];
	const verifier: ClerkBrowserIdentityVerifier = {
		verifyGoogleIdentity: vi.fn<ClerkBrowserIdentityVerifier['verifyGoogleIdentity']>(
			async (value) => ({ kind: 'verified', identity: value }),
		),
		verifyCurrentCookie: async () => ({ kind: 'not-current' }),
		verifyBootstrap: vi.fn<ClerkBrowserIdentityVerifier['verifyBootstrap']>(async () => ({
			kind: 'verified',
			identity,
			setCookies: [],
		})),
		verifySession: vi.fn<ClerkBrowserIdentityVerifier['verifySession']>(async () => ({
			kind: 'verified',
			identity,
		})),
		revokeSession: vi.fn<ClerkBrowserIdentityVerifier['revokeSession']>(async () => ({
			kind: 'revoked',
		})),
	};
	return {
		verifier,
		continuations,
		bound,
		app: createClerkLoginRoutes({
			...page,
			verifier,
			continuations,
			bindVerifiedContinuation: async (value) => {
				bound.push(value);
				return [];
			},
		}),
	};
}

function loginCookie(
	continuations: ReturnType<typeof createOAuthLoginContinuationStore>,
	target: unknown = { kind: 'agents' },
): string {
	const entry = continuations.create(target);
	if (entry.kind !== 'created') throw new Error('Expected continuation');
	return `agent_vm_oauth_login=${entry.continuationId}; agent_vm_oauth_login_binding=${entry.browserBindingSecret}`;
}

describe('Clerk safe login routes with real Hono and continuation storage', () => {
	it('opens a fresh invitation with bound cookies without exposing its ticket in HTML', async () => {
		const { app, verifier, bound } = fixture();
		const verify = vi.spyOn(verifier, 'verifyBootstrap');
		const response = await app.request(`${site}/oauth/auth/invite?__clerk_ticket=private-ticket`);
		expect(response.status).toBe(200);
		expect(response.headers.getSetCookie()).toHaveLength(2);
		const html = await response.text();
		expect(html).toContain('Continue with Google');
		expect(html).not.toContain('private-ticket');
		expect(verify).not.toHaveBeenCalled();
		expect(bound).toEqual([]);
	});
	it('shows setup immediately and never binds an email-only session', async () => {
		const { app, verifier, bound } = fixture();
		vi.spyOn(verifier, 'verifyGoogleIdentity').mockResolvedValue({ kind: 'setup-required' });
		const response = await app.request(`${site}/oauth/auth/start`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Connect Google to finish setup');
		expect(bound).toEqual([]);
	});
	it('pins the current verified person before sign-out and rejects another owner on return', async () => {
		const { app, verifier, continuations, bound } = fixture();
		const cookie = loginCookie(continuations);
		vi.spyOn(verifier, 'verifyCurrentCookie').mockResolvedValue({ kind: 'verified', identity });
		expect(
			(
				await app.request(`${site}/oauth/auth/prepare-google`, {
					method: 'POST',
					headers: { cookie, origin: site },
				})
			).status,
		).toBe(204);
		const other = { ...identity, userId: 'other-owner', sessionId: 'other-session' };
		vi.spyOn(verifier, 'verifyBootstrap').mockResolvedValue({
			kind: 'verified',
			identity: other,
			setCookies: [],
		});
		vi.spyOn(verifier, 'verifySession').mockResolvedValue({ kind: 'verified', identity: other });
		const response = await app.request(`${site}/oauth/auth/return`, { headers: { cookie } });
		expect(response.status).toBe(409);
		expect(bound).toEqual([]);
	});
	it.each([undefined, 'https://hostile.example'])(
		'rejects prepare with wrong Origin %s',
		async (origin) => {
			const { app, verifier, continuations } = fixture();
			const verify = vi.spyOn(verifier, 'verifyCurrentCookie');
			const response = await app.request(`${site}/oauth/auth/prepare-google`, {
				method: 'POST',
				headers: {
					cookie: loginCookie(continuations),
					...(origin === undefined ? {} : { origin }),
				},
			});
			expect(response.status).toBe(403);
			expect(verify).not.toHaveBeenCalled();
		},
	);
	it('never trusts a submitted user ID without a current verified cookie', async () => {
		const { app, continuations } = fixture();
		expect(
			(
				await app.request(`${site}/oauth/auth/prepare-google`, {
					method: 'POST',
					headers: { cookie: loginCookie(continuations), origin: site },
					body: JSON.stringify(identity),
				})
			).status,
		).toBe(400);
	});
	it('requires a live continuation before callback SDK work', async () => {
		const { app, continuations } = fixture();
		expect((await app.request(`${site}/oauth/auth/callback`)).status).toBe(409);
		const response = await app.request(`${site}/oauth/auth/callback`, {
			headers: { cookie: loginCookie(continuations) },
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Finishing sign-in');
	});
	it('runs the real SDK, route and continuation store with only the remote BAPI mocked', async () => {
		// Arrange
		const now = Date.now();
		const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
		const claims = Buffer.from(
			JSON.stringify({
				iss: identity.issuer,
				sub: identity.userId,
				sid: identity.sessionId,
				azp: site,
				exp: Math.floor(now / 1000) + 60,
				iat: Math.floor(now / 1000),
				nbf: Math.floor(now / 1000),
			}),
		).toString('base64url');
		const unsigned = `${header}.${claims}`;
		const token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
		const client = createClerkClient({
			publishableKey: `pk_test_${Buffer.from('clerk.example.test$').toString('base64')}`,
			secretKey: 'sk_test_fixture',
			jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
			telemetry: { disabled: true },
		});
		const verifier = createClerkBrowserIdentityVerifier({
			client,
			verifySessionToken: async () => {
				throw new Error('Cookie verification is not used by this bootstrap-only fixture.');
			},
			sessionCookieNames: ['__session'],
			issuer: identity.issuer,
			websiteOrigin: site,
			hostedSignInUrl: 'https://accounts.example.test/sign-in',
		});
		const remoteCalls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request): Promise<Response> => {
				remoteCalls.push(input instanceof Request ? input.url : input.toString());
				if (remoteCalls.at(-1)?.includes('/users/'))
					return Response.json({
						object: 'user',
						id: identity.userId,
						primary_email_address_id: 'email_primary',
						email_addresses: [
							{
								object: 'email_address',
								id: 'email_primary',
								linked_to: [],
								email_address: 'member@example.test',
								verification: { status: 'verified', strategy: 'oauth_google' },
							},
						],
						external_accounts: [
							{
								object: 'google_account',
								id: 'external_google',
								provider: 'oauth_google',
								provider_user_id: 'google_member',
								email_address: 'member@example.test',
								verification: { status: 'verified', strategy: 'oauth_google' },
							},
						],
					});
				return Response.json({
					object: 'session',
					id: identity.sessionId,
					user_id: identity.userId,
					client_id: 'client_test',
					status: 'active',
					actor: null,
					expire_at: now + 300_000,
					abandon_at: now + 600_000,
					created_at: now,
					updated_at: now,
					last_active_at: now,
				});
			}),
		);
		const continuations = createOAuthLoginContinuationStore();
		const bound: unknown[] = [];
		const app = createClerkLoginRoutes({
			...page,
			verifier,
			continuations,
			bindVerifiedContinuation: async (value) => {
				bound.push(value);
				return [];
			},
		});
		// Act
		const response = await app.request(`${site}/oauth/auth/return`, {
			headers: { cookie: loginCookie(continuations), authorization: `Bearer ${token}` },
		});
		// Assert
		expect(response.status).toBe(303);
		expect(bound).toEqual([{ target: { kind: 'agents' }, identity }]);
		expect(remoteCalls).toEqual([
			'https://api.clerk.com/v1/sessions/sess_owner',
			'https://api.clerk.com/v1/users/user_owner',
		]);
		expect(response.headers.get('location')).toBe('/oauth/agents');
		expect(await response.text()).not.toContain(token);
	});
	it('binds the verified human and performs a clean local redirect', async () => {
		// Arrange
		const { app, continuations, bound } = fixture();
		const cookie = loginCookie(continuations);
		// Act
		const response = await app.request(`${site}/oauth/auth/return`, { headers: { cookie } });
		// Assert
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/oauth/agents');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(bound).toEqual([{ target: { kind: 'agents' }, identity }]);
		expect((await app.request(`${site}/oauth/auth/return`, { headers: { cookie } })).status).toBe(
			409,
		);
	});

	it('shows our Google entry without leaking account destinations', async () => {
		// Arrange
		const { app, verifier, continuations } = fixture();
		vi.spyOn(verifier, 'verifyBootstrap').mockResolvedValue({ kind: 'signed-out' });
		const cookie = loginCookie(continuations, {
			kind: 'account',
			agentId: 'ember',
			accountId: '11111111-1111-4111-8111-111111111111',
		});
		// Act
		const response = await app.request(`${site}/oauth/auth/start`, { headers: { cookie } });
		// Assert
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('Continue with Google');
		expect(html).not.toContain('ember');
		expect(html).not.toContain('11111111-1111');
	});

	it('creates Secure HttpOnly bounded cookies for a new login', async () => {
		// Arrange
		const { app, verifier } = fixture();
		vi.spyOn(verifier, 'verifyBootstrap').mockResolvedValue({ kind: 'signed-out' });
		// Act
		const response = await app.request(`${site}/oauth/auth/start`);
		// Assert
		const cookies = response.headers.getSetCookie();
		expect(cookies).toHaveLength(2);
		for (const cookie of cookies) {
			expect(cookie).toContain('Secure');
			expect(cookie).toContain('HttpOnly');
			expect(cookie).toContain('SameSite=Lax');
			expect(cookie).toContain('Max-Age=600');
		}
	});

	it.each(['signed-out', 'identity-mismatch', 'verification-unavailable'] as const)(
		'does not bind a session that fails live verification: %s',
		async (kind) => {
			// Arrange
			const { app, verifier, continuations, bound } = fixture();
			vi.spyOn(verifier, 'verifySession').mockResolvedValue({ kind });
			// Act
			const response = await app.request(`${site}/oauth/auth/return`, {
				headers: { cookie: loginCookie(continuations) },
			});
			// Assert
			expect(response.status).toBe(kind === 'verification-unavailable' ? 503 : 403);
			expect(bound).toEqual([]);
		},
	);

	it('never exposes Google callback or POST data to the Clerk verifier', async () => {
		// Arrange
		const { app, verifier } = fixture();
		const verify = vi.spyOn(verifier, 'verifyBootstrap');
		// Act
		const callback = await app.request(`${site}/oauth/google/callback?code=private-code`);
		const post = await app.request(`${site}/oauth/auth/return`, {
			method: 'POST',
			body: 'private-body',
		});
		// Assert
		expect(callback.status).toBe(404);
		expect(post.status).toBe(404);
		expect(verify).not.toHaveBeenCalled();
	});

	it('bounds repeated SDK handshake redirects and preserves separate cookies', async () => {
		// Arrange
		const { app, verifier, continuations } = fixture();
		vi.spyOn(verifier, 'verifyBootstrap').mockResolvedValue({
			kind: 'redirect',
			location: 'https://clerk.example.test/v1/client/handshake',
			setCookies: ['first=1; Secure', 'second=2; Secure'],
		});
		const cookie = loginCookie(continuations);
		// Act / Assert
		for (let index = 0; index < 5; index++) {
			// oxlint-disable-next-line no-await-in-loop -- each response advances the bounded handshake sequence.
			const response = await app.request(`${site}/oauth/auth/return`, { headers: { cookie } });
			expect(response.status).toBe(307);
			expect(response.headers.getSetCookie()).toEqual(['first=1; Secure', 'second=2; Secure']);
		}
		expect((await app.request(`${site}/oauth/auth/return`, { headers: { cookie } })).status).toBe(
			409,
		);
	});
});
