import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

import { createPersonTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import {
	cachedOwnerTokenSchema,
	requirePrivateRuntimePath,
	saveOwnerToken,
	type AuthTarget,
} from '#auth/native-owner-cli/auth-target';

export function ownerPkceChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}

async function openBrowser(url: string): Promise<void> {
	const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
	await promisify(execFile)(command, [url]);
}

/** Public native code+S256 flow. An expired credential requires another browser sign-in; no refresh exists. */
export async function ownerManagementToken(props: {
	readonly target: AuthTarget;
	readonly forceAuth?: boolean;
	readonly browser?: (url: string) => Promise<void>;
	readonly now?: () => number;
}): Promise<string> {
	const target = props.target;
	const now = props.now ?? Date.now;
	const verifier = createPersonTokenVerifier({
		deployment: target.issuer,
		audience: target.managementAudience,
		jwksUrl: new URL('/api/auth/jwks', target.issuer),
		now,
	});
	if (props.forceAuth !== true) {
		try {
			const cached = cachedOwnerTokenSchema.parse(
				JSON.parse(
					await readFile(await requirePrivateRuntimePath(target.tokenCachePath, true), 'utf8'),
				),
			);
			if (
				cached.issuer === target.issuer &&
				cached.audience === target.managementAudience &&
				cached.clientId === target.ownerCliClientId &&
				cached.expiresAt > now()
			) {
				const checked = await verifier.verify(cached.token);
				if (checked.kind === 'verified') return cached.token;
			}
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		}
	}
	const codeVerifier = randomBytes(32).toString('base64url');
	const state = randomBytes(32).toString('base64url');
	const redirect = new URL(target.ownerCliRedirectUri);
	const callback = Promise.withResolvers<string>();
	const callbackResult = callback.promise.then(
		(code) =>
			({ kind: 'authorized', code }) satisfies {
				readonly kind: 'authorized';
				readonly code: string;
			},
		() => ({ kind: 'refused' }) satisfies { readonly kind: 'refused' },
	);
	const server = createServer((request, response) => {
		const received = new URL(request.url ?? '/', redirect.origin);
		if (
			request.method !== 'GET' ||
			received.pathname !== redirect.pathname ||
			received.searchParams.get('state') !== state
		) {
			response.writeHead(400).end('Invalid owner sign-in callback.');
			return;
		}
		const code = received.searchParams.get('code');
		if (
			received.searchParams.get('iss') !== target.issuer ||
			code === null ||
			received.searchParams.has('error')
		) {
			response.writeHead(400).end('Owner sign-in refused.');
			callback.reject(new Error('Owner authorization refused'));
			return;
		}
		response
			.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
			.end('Owner sign-in complete. Return to the CLI.');
		callback.resolve(code);
	});
	server.on('error', callback.reject);
	const timeout = setTimeout(
		() => callback.reject(new Error('Owner loopback sign-in timed out')),
		300_000,
	);
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once('error', rejectListen);
			server.listen(
				{
					host: redirect.hostname.replace(/^\[|\]$/g, ''),
					port: redirect.port === '' ? 0 : Number(redirect.port),
				},
				resolveListen,
			);
		});
		const address = server.address();
		if (address === null || typeof address === 'string')
			throw new Error('Owner loopback listener unavailable');
		redirect.port = String(address.port);
		const authorization = new URL('/api/auth/oauth2/authorize', target.issuer);
		authorization.search = new URLSearchParams({
			client_id: target.ownerCliClientId,
			response_type: 'code',
			redirect_uri: redirect.toString(),
			scope: 'tool-portal:management',
			resource: target.managementAudience,
			code_challenge: ownerPkceChallenge(codeVerifier),
			code_challenge_method: 'S256',
			state,
		}).toString();
		const browserUrl = new URL('/sign-in', target.issuer);
		browserUrl.searchParams.set('authorize', authorization.toString());
		await (props.browser ?? openBrowser)(browserUrl.toString());
		const authorizationResult = await callbackResult;
		if (authorizationResult.kind !== 'authorized')
			throw new Error('Owner authorization refused or timed out');
		const code = authorizationResult.code;
		const result = await fetch(new URL('/api/auth/oauth2/token', target.issuer), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: target.ownerCliClientId,
				code,
				code_verifier: codeVerifier,
				redirect_uri: redirect.toString(),
				resource: target.managementAudience,
			}),
		});
		if (!result.ok) throw new Error('Owner code exchange refused');
		const token = z
			.object({
				access_token: z.string(),
				expires_in: z.number().positive().max(300),
				refresh_token: z.never().optional(),
			})
			.parse(await result.json());
		const checked = await verifier.verify(token.access_token);
		if (
			checked.kind !== 'verified' ||
			checked.proof.clientId !== target.ownerCliClientId ||
			checked.proof.expiresAt * 1000 > now() + 300_000
		)
			throw new Error('Owner token failed verification');
		await saveOwnerToken(target.tokenCachePath, {
			issuer: target.issuer,
			audience: target.managementAudience,
			clientId: target.ownerCliClientId,
			token: token.access_token,
			expiresAt: checked.proof.expiresAt * 1000,
		});
		return token.access_token;
	} finally {
		clearTimeout(timeout);
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}
