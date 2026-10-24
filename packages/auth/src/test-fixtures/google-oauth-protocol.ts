import { createHash } from 'node:crypto';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Response as WorkerResponse, type V4FetchHandler } from 'miniflare';

interface ProviderCode {
	readonly challenge: string;
	readonly redirectUri: string;
	readonly email: string;
	readonly verified: boolean;
}

/** Only the external Google protocol is controlled. Better Auth's own provider/router/database stay real. */
export async function createGoogleOAuthProtocol(): Promise<{
	readonly authorize: (url: URL, email?: string, verified?: boolean) => URL;
	readonly fetch: V4FetchHandler;
	readonly exchanges: () => number;
}> {
	const keys = await generateKeyPair('RS256');
	const publicKey = {
		...(await exportJWK(keys.publicKey)),
		kid: 'google-fixture',
		alg: 'RS256',
		use: 'sig',
	};
	const codes = new Map<string, ProviderCode>();
	let exchanges = 0;
	return {
		exchanges: () => exchanges,
		authorize(url, email = 'owner@example.invalid', verified = true): URL {
			if (
				url.origin !== 'https://accounts.google.com' ||
				url.pathname !== '/o/oauth2/v2/auth' ||
				url.searchParams.get('code_challenge_method') !== 'S256'
			)
				throw new Error('Unexpected Google authorization protocol');
			const challenge = url.searchParams.get('code_challenge');
			const redirectUri = url.searchParams.get('redirect_uri');
			const state = url.searchParams.get('state');
			if (challenge === null || redirectUri === null || state === null)
				throw new Error('Incomplete Google authorization protocol');
			const code = crypto.randomUUID();
			codes.set(code, { challenge, redirectUri, email, verified });
			const callback = new URL(redirectUri);
			callback.searchParams.set('code', code);
			callback.searchParams.set('state', state);
			return callback;
		},
		async fetch(request): Promise<WorkerResponse> {
			const url = new URL(request.url);
			if (url.href === 'https://www.googleapis.com/oauth2/v3/certs')
				return WorkerResponse.json({ keys: [publicKey] });
			if (url.href !== 'https://oauth2.googleapis.com/token' || request.method !== 'POST')
				return WorkerResponse.json({ error: 'unexpected-provider-request' }, { status: 503 });
			const body = new URLSearchParams(await request.text());
			const code = body.get('code');
			const issued = codes.get(code ?? '');
			if (
				issued === undefined ||
				body.get('grant_type') !== 'authorization_code' ||
				body.get('redirect_uri') !== issued.redirectUri ||
				createHash('sha256')
					.update(body.get('code_verifier') ?? '')
					.digest('base64url') !== issued.challenge
			)
				return WorkerResponse.json({ error: 'invalid_grant' }, { status: 400 });
			codes.delete(code ?? '');
			exchanges += 1;
			const now = Math.floor(Date.now() / 1000);
			const token = await new SignJWT({
				iss: 'https://accounts.google.com',
				sub: `provider:${issued.email}`,
				aud: 'fixture-google-client',
				iat: now,
				exp: now + 300,
				email: issued.email,
				email_verified: issued.verified,
				name: 'Fixture Owner',
			})
				.setProtectedHeader({ alg: 'RS256', kid: 'google-fixture' })
				.sign(keys.privateKey);
			return WorkerResponse.json({
				access_token: `provider-access-${crypto.randomUUID()}`,
				id_token: token,
				token_type: 'Bearer',
				expires_in: 300,
				scope: 'openid email profile',
			});
		},
	};
}
