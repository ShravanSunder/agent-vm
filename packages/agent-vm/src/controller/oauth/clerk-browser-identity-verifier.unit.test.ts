import { generateKeyPairSync, sign, type KeyObject, type webcrypto } from 'node:crypto';

import { createClerkClient, verifyToken } from '@clerk/backend';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createClerkBrowserIdentityVerifier,
	createConfiguredClerkBrowserIdentityVerifier,
} from './clerk-browser-identity-verifier.js';

const websiteOrigin = 'https://auth.example.test:18900';
const issuer = 'https://clerk.example.test';
const hostedSignInUrl = 'https://accounts.example.test/sign-in';
const nowMs = 1_788_600_000_000;
const identity = { issuer, sessionId: 'sess_test_owner', userId: 'user_test_owner' };
const publishableKey = `pk_live_${Buffer.from('clerk.example.test$').toString('base64')}`;
let signingKey: KeyObject;
let publicKeyPem: string;
let verificationJwk: webcrypto.JsonWebKey;

beforeAll(() => {
	const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
	signingKey = keys.privateKey;
	publicKeyPem = keys.publicKey.export({ format: 'pem', type: 'spki' });
	verificationJwk = keys.publicKey.export({ format: 'jwk' });
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(nowMs);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (): Promise<Response> => {
			throw new Error('Unexpected external request in Clerk unit test');
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function sessionToken(overrides: Readonly<Record<string, unknown>> = {}): string {
	const header = Buffer.from(
		JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }),
	).toString('base64url');
	const payload = Buffer.from(
		JSON.stringify({
			azp: websiteOrigin,
			exp: nowMs / 1000 + 60,
			iat: nowMs / 1000,
			iss: issuer,
			nbf: nowMs / 1000,
			sid: identity.sessionId,
			sub: identity.userId,
			...overrides,
		}),
	).toString('base64url');
	const unsigned = `${header}.${payload}`;
	return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), signingKey).toString('base64url')}`;
}

function fixture(): {
	readonly client: ReturnType<typeof createClerkClient>;
	readonly verifier: ReturnType<typeof createClerkBrowserIdentityVerifier>;
} {
	const client = createClerkClient({
		jwtKey: publicKeyPem,
		publishableKey,
		secretKey: 'sk_test_unit_only',
		telemetry: { disabled: true },
	});
	return {
		client,
		verifier: createClerkBrowserIdentityVerifier({
			client,
			verifySessionToken: async (token) =>
				await verifyToken(token, {
					jwtKey: publicKeyPem,
					authorizedParties: [websiteOrigin],
					clockSkewInMs: 0,
				}),
			sessionCookieNames: ['__session'],
			hostedSignInUrl,
			issuer,
			websiteOrigin,
			now: () => nowMs,
			requestTimeoutMs: 1000,
		}),
	};
}

function bootstrapRequest(token = sessionToken()): Request {
	return new Request(`${websiteOrigin}/oauth/auth/return`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

function sessionResponse(overrides: Readonly<Record<string, unknown>> = {}): Response {
	return Response.json({
		object: 'session',
		id: identity.sessionId,
		user_id: identity.userId,
		client_id: 'client_test',
		status: 'active',
		actor: null,
		expire_at: nowMs + 300_000,
		abandon_at: nowMs + 600_000,
		created_at: nowMs - 1000,
		updated_at: nowMs,
		last_active_at: nowMs,
		...overrides,
	});
}

describe('Clerk browser bootstrap through the real SDK', () => {
	it('checks the current cookie on a callback without invoking the handshake API or passing its code', async () => {
		const { client, verifier } = fixture();
		const authenticate = vi.spyOn(client, 'authenticateRequest');
		const request = new Request(`${websiteOrigin}/oauth/google/callback?code=private-code`, {
			headers: { cookie: `__session=${sessionToken()}` },
		});
		expect(await verifier.verifyCurrentCookie(request)).toEqual({ kind: 'verified', identity });
		expect(authenticate).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	it('treats an expired JWT as no current cookie identity, but never trusts its decoded claims', async () => {
		const { verifier } = fixture();
		const expired = sessionToken({ exp: nowMs / 1000 - 1, iat: nowMs / 1000 - 60 });
		expect(
			await verifier.verifyCurrentCookie(
				new Request(websiteOrigin, { headers: { cookie: `__session=${expired}` } }),
			),
		).toEqual({ kind: 'not-current' });
		const invalid = `${expired.slice(0, -5)}abcde`;
		expect(
			(
				await verifier.verifyCurrentCookie(
					new Request(websiteOrigin, { headers: { cookie: `__session=${invalid}` } }),
				)
			).kind,
		).not.toBe('verified');
	});
	it('checks issuer explicitly even when the cookie has a valid signature', async () => {
		const { verifier } = fixture();
		expect(
			await verifier.verifyCurrentCookie(
				new Request(websiteOrigin, {
					headers: { cookie: `__session=${sessionToken({ iss: 'https://other.example.test' })}` },
				}),
			),
		).toEqual({ kind: 'identity-mismatch' });
	});
	it('constructs the production SDK client and verifies using its fetched public key', async () => {
		// Arrange
		const requests: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request): Promise<Response> => {
				requests.push(input instanceof Request ? input.url : input.toString());
				return Response.json({
					keys: [{ ...verificationJwk, kid: 'test-key', use: 'sig', alg: 'RS256' }],
				});
			}),
		);
		const verifier = createConfiguredClerkBrowserIdentityVerifier({
			issuer,
			websiteOrigin,
			hostedSignInUrl,
			publishableKey,
			secretKey: 'sk_test_unit_only',
			now: () => nowMs,
		});
		// Act / Assert
		expect(await verifier.verifyBootstrap(bootstrapRequest())).toEqual({
			kind: 'verified',
			identity,
			setCookies: [],
		});
		expect(requests).toEqual(['https://api.clerk.com/v1/jwks']);
	});
	it('verifies a browser cookie through the actual SDK', async () => {
		// Arrange
		const { verifier } = fixture();
		const request = new Request(`${websiteOrigin}/oauth/auth/return`, {
			headers: {
				cookie: `__session=${sessionToken()}; __client_uat=${nowMs / 1000}`,
			},
		});
		// Act / Assert
		expect(await verifier.verifyBootstrap(request)).toEqual({
			kind: 'verified',
			identity,
			setCookies: [],
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('passes the supported Clerk handshake nonce only on the safe return', async () => {
		// Arrange
		const { client, verifier } = fixture();
		const state = await client.authenticateRequest(bootstrapRequest(), {
			acceptsToken: 'session_token',
		});
		const authenticate = vi.spyOn(client, 'authenticateRequest').mockResolvedValue(state);
		// Act
		const result = await verifier.verifyBootstrap(
			new Request(`${websiteOrigin}/oauth/auth/return?__clerk_handshake_nonce=test-nonce`),
		);
		// Assert
		expect(result.kind).toBe('verified');
		expect(authenticate.mock.calls[0]?.[0].url).toContain('__clerk_handshake_nonce=test-nonce');
	});

	it.each([
		'https://clerk.example.test/v1/client/handshake',
		'https://accounts.example.test/sign-in',
		`${websiteOrigin}/oauth/auth/return`,
	])('preserves distinct Set-Cookie headers for trusted redirect %s', async (location) => {
		// Arrange
		const { client, verifier } = fixture();
		const state = await client.authenticateRequest(
			new Request(`${websiteOrigin}/oauth/auth/return`),
			{ acceptsToken: 'session_token' },
		);
		const headers = new Headers({ location });
		headers.append('set-cookie', '__session=first; HttpOnly; Secure; Path=/');
		headers.append('set-cookie', '__clerk_redirect_count=1; HttpOnly; Secure; Path=/');
		vi.spyOn(client, 'authenticateRequest').mockResolvedValue({
			...state,
			status: 'handshake',
			tokenType: 'session_token',
			token: null,
			isAuthenticated: false,
			isSignedIn: false,
			reason: 'session-token-expired',
			message: 'test handshake',
			headers,
			toAuth: () => null,
		});
		// Act / Assert
		expect(
			await verifier.verifyBootstrap(new Request(`${websiteOrigin}/oauth/auth/return`)),
		).toEqual({ kind: 'redirect', location, setCookies: headers.getSetCookie() });
	});

	it.each([
		'https://clerk.example.test.evil.example/steal',
		'http://clerk.example.test/',
		'https://user:password@clerk.example.test/',
		'https://evil.example/',
		`${websiteOrigin}/oauth/google/callback`,
		`${websiteOrigin}/oauth/auth/return?code=private-code`,
	])('refuses untrusted SDK redirect %s', async (location) => {
		// Arrange
		const { client, verifier } = fixture();
		const state = await client.authenticateRequest(
			new Request(`${websiteOrigin}/oauth/auth/return`),
			{ acceptsToken: 'session_token' },
		);
		vi.spyOn(client, 'authenticateRequest').mockResolvedValue({
			...state,
			status: 'handshake',
			tokenType: 'session_token',
			token: null,
			isAuthenticated: false,
			isSignedIn: false,
			reason: 'session-token-expired',
			message: 'test handshake',
			headers: new Headers({ location }),
			toAuth: () => null,
		});
		// Act / Assert
		expect(
			(await verifier.verifyBootstrap(new Request(`${websiteOrigin}/oauth/auth/return`))).kind,
		).toBe('identity-mismatch');
	});

	it('fails a handshake without Location instead of treating it as authenticated', async () => {
		// Arrange
		const { client, verifier } = fixture();
		const state = await client.authenticateRequest(
			new Request(`${websiteOrigin}/oauth/auth/return`),
			{ acceptsToken: 'session_token' },
		);
		vi.spyOn(client, 'authenticateRequest').mockResolvedValue({
			...state,
			status: 'handshake',
			tokenType: 'session_token',
			token: null,
			isAuthenticated: false,
			isSignedIn: false,
			reason: 'session-token-expired',
			message: 'test handshake',
			headers: new Headers(),
			toAuth: () => null,
		});
		// Act / Assert
		expect(
			await verifier.verifyBootstrap(new Request(`${websiteOrigin}/oauth/auth/return`)),
		).toEqual({ kind: 'verification-unavailable' });
	});
	it('verifies an actual RSA-signed session and exposes only portable identity', async () => {
		// Arrange
		const { verifier } = fixture();
		// Act
		const result = await verifier.verifyBootstrap(bootstrapRequest());
		// Assert
		expect(result).toEqual({ kind: 'verified', identity, setCookies: [] });
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{ iss: 'https://other.example.test' },
		{ iss: undefined },
		{ azp: 'https://auth.example.test' },
		{ azp: undefined },
		{ azp: 'https://accounts.example.test' },
		{ sid: '' },
		{ sid: undefined },
		{ act: { sub: 'user_impersonator' } },
		{ act: null },
		{ exp: nowMs / 1000 - 1 },
		{ iat: nowMs / 1000 + 20 },
		{ nbf: nowMs / 1000 + 20 },
		{ sts: 'pending' },
	])('fails closed for invalid or excessive claims: %j', async (claims) => {
		// Arrange
		const { verifier } = fixture();
		// Act
		const result = await verifier.verifyBootstrap(bootstrapRequest(sessionToken(claims)));
		// Assert
		expect(result.kind).not.toBe('verified');
		expect(JSON.stringify(result)).not.toContain('user_impersonator');
	});

	it('rejects a tampered signature', async () => {
		// Arrange
		const { verifier } = fixture();
		const token = sessionToken();
		const tampered = `${token.slice(0, token.lastIndexOf('.') + 1)}AAAA`;
		// Act / Assert
		expect((await verifier.verifyBootstrap(bootstrapRequest(tampered))).kind).not.toBe('verified');
	});

	it.each(['oauth_at_test', 'm2m_test', 'ak_test'])('rejects machine token %s', async (token) => {
		// Arrange
		const { verifier } = fixture();
		// Act / Assert
		expect((await verifier.verifyBootstrap(bootstrapRequest(token))).kind).not.toBe('verified');
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		['GET', '/oauth/google/callback?code=private-code&state=private-state'],
		['POST', '/oauth/auth/return'],
		['GET', '/oauth/agents'],
		['GET', '/oauth/auth/return?returnTo=https://evil.example'],
		['GET', '/oauth/auth/return?code=private-code'],
	])('never invokes SDK handshake on %s %s', async (method, route) => {
		// Arrange
		const { client, verifier } = fixture();
		const authenticate = vi.spyOn(client, 'authenticateRequest');
		// Act
		const result = await verifier.verifyBootstrap(
			new Request(`${websiteOrigin}${route}`, { method }),
		);
		// Assert
		expect(result.kind).toBe('identity-mismatch');
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('constructs the configured origin and strips spoofed forwarded identity headers', async () => {
		// Arrange
		const { client, verifier } = fixture();
		const authenticate = vi.spyOn(client, 'authenticateRequest');
		const request = new Request('https://evil.example/oauth/auth/return', {
			headers: {
				authorization: `Bearer ${sessionToken()}`,
				forwarded: 'host=evil.example;proto=http',
				'x-forwarded-host': 'evil.example',
				'x-forwarded-proto': 'http',
				host: 'evil.example',
			},
		});
		// Act
		const result = await verifier.verifyBootstrap(request);
		// Assert
		expect(result.kind).toBe('verified');
		const sanitized = authenticate.mock.calls[0]?.[0];
		expect(sanitized?.url).toBe(`${websiteOrigin}/oauth/auth/return`);
		expect(sanitized?.headers.has('forwarded')).toBe(false);
		expect(sanitized?.headers.has('x-forwarded-host')).toBe(false);
		expect(sanitized?.headers.has('x-forwarded-proto')).toBe(false);
		expect(sanitized?.headers.has('host')).toBe(false);
	});

	it('builds a fixed login return without carrying caller data', () => {
		// Arrange
		const { verifier } = fixture();
		// Act
		const url = new URL(verifier.signInUrl());
		// Assert
		expect(url.origin).toBe('https://accounts.example.test');
		expect([...url.searchParams]).toEqual([['redirect_url', `${websiteOrigin}/oauth/auth/return`]]);
	});
});

describe('Clerk active-session checks through SDK BAPI deserialization', () => {
	it('looks up the bound session on every transition, without social OAuth tokens', async () => {
		// Arrange
		const { verifier } = fixture();
		const fetchMock = vi.fn(async (): Promise<Response> => sessionResponse());
		vi.stubGlobal('fetch', fetchMock);
		// Act
		const first = await verifier.verifySession(identity);
		const second = await verifier.verifySession(identity);
		// Assert
		expect(first).toEqual({ kind: 'verified', identity });
		expect(second).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls).toHaveLength(2);
	});

	it.each([
		{ id: 'sess_other' },
		{ user_id: 'user_other' },
		{ status: 'revoked' },
		{ status: 'pending' },
		{ status: 'replaced' },
		{ status: 'ended' },
		{ status: 'expired' },
		{ status: 'abandoned' },
		{ status: 'removed' },
		{ status: 'ACTIVE' },
		{ actor: { sub: 'user_other' } },
		{ expire_at: nowMs },
		{ expire_at: nowMs / 1000 + 60 },
		{ expire_at: 'tomorrow' },
	])('rejects an inactive, foreign or malformed session %j', async (overrides) => {
		// Arrange
		const { verifier } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => sessionResponse(overrides)),
		);
		// Act / Assert
		expect((await verifier.verifySession(identity)).kind).not.toBe('verified');
	});

	it('does not look up a bound identity from another issuer', async () => {
		// Arrange
		const { verifier } = fixture();
		// Act / Assert
		expect(
			await verifier.verifySession({ ...identity, issuer: 'https://other.example.test' }),
		).toEqual({ kind: 'identity-mismatch' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('bounds a hung provider request without accepting a late response', async () => {
		// Arrange
		const { verifier } = fixture();
		let complete: ((response: Response) => void) | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						complete = resolve;
					}),
			),
		);
		// Act
		const result = verifier.verifySession(identity);
		await vi.advanceTimersByTimeAsync(1001);
		// Assert
		await expect(result).resolves.toEqual({ kind: 'verification-unavailable' });
		complete?.(sessionResponse());
		await expect(result).resolves.toEqual({ kind: 'verification-unavailable' });
	});

	it('returns no provider diagnostics or secrets on failure', async () => {
		// Arrange
		const { verifier } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async (): Promise<Response> =>
					Response.json(
						{
							errors: [{ code: 'forbidden', message: 'private-provider-detail' }],
						},
						{ status: 403 },
					),
			),
		);
		// Act / Assert
		expect(await verifier.verifySession(identity)).toEqual({ kind: 'verification-unavailable' });
	});

	it('revokes only the bound Clerk session and verifies the returned target/state', async () => {
		// Arrange
		const { verifier } = fixture();
		const requests: { url: string; method: string | undefined }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				requests.push({
					url: input instanceof Request ? input.url : input.toString(),
					method: init?.method,
				});
				return sessionResponse({ status: 'revoked' });
			}),
		);
		// Act / Assert
		expect(await verifier.revokeSession(identity)).toEqual({ kind: 'revoked' });
		expect(requests).toEqual([
			{ url: 'https://api.clerk.com/v1/sessions/sess_test_owner/revoke', method: 'POST' },
		]);
	});

	it('does not report successful logout when the backend still returns active', async () => {
		// Arrange
		const { verifier } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => sessionResponse()),
		);
		// Act / Assert
		expect(await verifier.revokeSession(identity)).toEqual({ kind: 'verification-unavailable' });
	});
});
