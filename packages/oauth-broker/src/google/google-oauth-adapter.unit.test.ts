import { oauthScopeSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createGoogleOAuthAdapter,
	parseGoogleWebClientCredentials,
} from './google-oauth-adapter.js';

const redirectUri = 'https://auth.claw.askluna.xyz/oauth/google/callback';
const rawClientCredentials = JSON.stringify({
	web: {
		auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
		auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
		client_id: 'google-client-id',
		client_secret: 'google-client-secret',
		project_id: 'agent-vm-test',
		redirect_uris: [redirectUri],
		token_uri: 'https://oauth2.googleapis.com/token',
	},
});

function clientCredentials() {
	return parseGoogleWebClientCredentials({
		expectedRedirectUri: redirectUri,
		rawClientCredentials,
	});
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json' },
		status,
	});
}

function requireUrlSearchParams(body: RequestInit['body']): URLSearchParams {
	if (!(body instanceof URLSearchParams)) {
		throw new Error('Expected an application/x-www-form-urlencoded request body.');
	}
	return body;
}

describe('Google OAuth adapter', () => {
	it('builds an offline PKCE authorization URL without the client secret', () => {
		const adapter = createGoogleOAuthAdapter();
		const url = new URL(
			adapter.buildAuthorizationUrl({
				clientCredentials: clientCredentials(),
				pkceChallenge: 'c'.repeat(43),
				redirectUri,
				requestedScopes: [oauthScopeSchema.parse('gmail.readonly')],
				state: 's'.repeat(43),
			}),
		);
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			access_type: 'offline',
			client_id: 'google-client-id',
			code_challenge: 'c'.repeat(43),
			code_challenge_method: 'S256',
			prompt: 'consent',
			redirect_uri: redirectUri,
			response_type: 'code',
			state: 's'.repeat(43),
		});
		expect(url.searchParams.get('scope')?.split(' ').toSorted()).toEqual([
			'email',
			'gmail.readonly',
			'openid',
		]);
		expect(url.toString()).not.toContain('google-client-secret');
	});

	it('exchanges one code with PKCE and discovers the stable Google subject', async () => {
		const fetchCalls: Array<{ readonly init: RequestInit | undefined; readonly url: string }> = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			fetchCalls.push({ init, url });
			if (url === 'https://oauth2.googleapis.com/token') {
				return jsonResponse({
					access_token: 'access-token',
					expires_in: 3_600,
					refresh_token: 'refresh-token',
					scope: 'openid email gmail.readonly',
					token_type: 'Bearer',
				});
			}
			return jsonResponse({
				email: 'human@example.test',
				email_verified: true,
				sub: 'google-subject-1',
			});
		});
		const adapter = createGoogleOAuthAdapter({ fetchImpl, now: () => 1_000 });
		const result = await adapter.exchangeAuthorizationCode({
			authorizationCode: 'single-use-code',
			clientCredentials: clientCredentials(),
			pkceVerifier: 'v'.repeat(43),
			redirectUri,
		});

		expect(result).toMatchObject({
			authorization: {
				accessTokenExpiresAtMs: 3_601_000,
				accountEmail: 'human@example.test',
				accountSubject: 'google-subject-1',
				kind: 'google-provider-authorization',
			},
			kind: 'authorized',
		});
		const tokenBody = fetchCalls[0]?.init?.body;
		expect(tokenBody).toBeInstanceOf(URLSearchParams);
		expect(Object.fromEntries(requireUrlSearchParams(tokenBody))).toMatchObject({
			client_id: 'google-client-id',
			client_secret: 'google-client-secret',
			code: 'single-use-code',
			code_verifier: 'v'.repeat(43),
			grant_type: 'authorization_code',
			redirect_uri: redirectUri,
		});
		expect(fetchCalls[0]?.url).not.toContain('single-use-code');
		expect(fetchCalls[0]?.url).not.toContain('google-client-secret');
		expect(fetchCalls[1]?.init?.headers).toEqual({ authorization: 'Bearer access-token' });
	});

	it('retains known scopes when refresh omits scope and accepts a replacement refresh token', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				access_token: 'new-access-token',
				expires_in: 1_800,
				refresh_token: 'replacement-refresh-token',
				token_type: 'Bearer',
			}),
		);
		const adapter = createGoogleOAuthAdapter({ fetchImpl, now: () => 2_000 });
		const result = await adapter.refreshAuthorization({
			clientCredentials: clientCredentials(),
			currentGrantedScopes: [oauthScopeSchema.parse('gmail.readonly')],
			refreshToken: 'current-refresh-token',
		});
		expect(result).toMatchObject({
			accessTokenExpiresAtMs: 1_802_000,
			grantedScopes: ['gmail.readonly'],
			kind: 'refreshed',
			replacementRefreshToken: 'replacement-refresh-token',
		});
	});

	it('classifies invalid_grant as permanent reauthorization input', async () => {
		const adapter = createGoogleOAuthAdapter({
			fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400),
		});
		expect(
			await adapter.refreshAuthorization({
				clientCredentials: clientCredentials(),
				currentGrantedScopes: [oauthScopeSchema.parse('gmail.readonly')],
				refreshToken: 'revoked-refresh-token',
			}),
		).toEqual({ failure: { kind: 'invalid-grant' }, kind: 'failed' });
	});

	it('revokes through a form body and never places the token in the URL', async () => {
		const fetchCalls: Array<{ readonly init: RequestInit | undefined; readonly url: string }> = [];
		const adapter = createGoogleOAuthAdapter({
			fetchImpl: async (input, init) => {
				fetchCalls.push({ init, url: String(input) });
				return new Response(null, { status: 200 });
			},
		});
		expect(await adapter.revokeAuthorization({ refreshToken: 'refresh-token-to-revoke' })).toEqual({
			kind: 'revoked',
		});
		expect(fetchCalls[0]?.url).toBe('https://oauth2.googleapis.com/revoke');
		expect(fetchCalls[0]?.url).not.toContain('refresh-token-to-revoke');
		expect(Object.fromEntries(requireUrlSearchParams(fetchCalls[0]?.init?.body))).toEqual({
			token: 'refresh-token-to-revoke',
		});
	});

	it('rejects a Web client that does not register the exact callback', () => {
		expect(() =>
			parseGoogleWebClientCredentials({
				expectedRedirectUri: 'https://auth.claw.askluna.xyz/oauth/google/other',
				rawClientCredentials,
			}),
		).toThrow('does not register');
	});
});
