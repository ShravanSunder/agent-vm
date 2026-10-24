import { createHash, randomBytes } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLocalAuthHarness,
	workspaceOne,
	registeredClientId,
	managementAudience,
} from '#auth/test-fixtures/local-auth-harness';

it('agent: native owner code rejects wrong PKCE/redirect, missing or plain PKCE, refresh, offline and reused code', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await harness.ownerToken();
		const clientsBefore = (
			await harness.database.prepare('SELECT * FROM oauthClient ORDER BY clientId').all()
		).results;
		async function authorize(changes: Readonly<Record<string, string | null>> = {}): Promise<{
			readonly response: Response;
			readonly verifier: string;
			readonly redirect: string;
		}> {
			const verifier = randomBytes(32).toString('base64url');
			const redirect = 'http://127.0.0.1:49152/callback';
			const params = new URLSearchParams({
				client_id: harness.target.ownerCliClientId,
				response_type: 'code',
				redirect_uri: redirect,
				scope: 'tool-portal:management',
				resource: managementAudience,
				code_challenge: createHash('sha256').update(verifier).digest('base64url'),
				code_challenge_method: 'S256',
				state: crypto.randomUUID(),
			});
			for (const [name, value] of Object.entries(changes)) {
				if (value === null) params.delete(name);
				else params.set(name, value);
			}
			const response = await harness.auth(`/api/auth/oauth2/authorize?${params.toString()}`, {
				headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
			});
			return { response, verifier, redirect };
		}
		async function code(): Promise<{
			readonly code: string;
			readonly verifier: string;
			readonly redirect: string;
		}> {
			const grant = await authorize();
			const location = grant.response.headers.get('location');
			expect(location !== null).toBe(true);
			if (location === null) throw new Error('Native authorization did not produce a callback');
			const callback = new URL(location);
			expect(callback.origin + callback.pathname).toBe(grant.redirect);
			expect(callback.searchParams.get('iss')).toBe(harness.issuer);
			return { ...grant, code: z.string().min(1).parse(callback.searchParams.get('code')) };
		}
		async function exchange(
			grant: { readonly code: string; readonly verifier: string; readonly redirect: string },
			changes: Readonly<Record<string, string>> = {},
		): Promise<Response> {
			return harness.auth('/api/auth/oauth2/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: harness.target.ownerCliClientId,
					code: grant.code,
					code_verifier: grant.verifier,
					redirect_uri: grant.redirect,
					resource: managementAudience,
					...changes,
				}),
			});
		}
		async function noToken(response: Response): Promise<void> {
			expect(response.ok).toBe(false);
			const body = z.record(z.string(), z.unknown()).parse(await response.json());
			expect(Object.hasOwn(body, 'access_token')).toBe(false);
			expect(Object.hasOwn(body, 'refresh_token')).toBe(false);
		}
		const wrongVerifier = await code();
		await noToken(
			await exchange(wrongVerifier, { code_verifier: randomBytes(32).toString('base64url') }),
		);
		const wrongRedirect = await code();
		await noToken(
			await exchange(wrongRedirect, { redirect_uri: 'http://127.0.0.1:49152/foreign' }),
		);
		const refusals = await Promise.all([
			authorize({ code_challenge: null, code_challenge_method: null }),
			authorize({ code_challenge_method: 'plain' }),
			authorize({ redirect_uri: 'https://foreign.invalid/callback' }),
			authorize({ scope: 'tool-portal:management offline_access' }),
		]);
		await Promise.all(
			refusals.map(async (refused) => {
				const location = refused.response.headers.get('location');
				if (location !== null) {
					const callback = new URL(location, harness.issuer);
					expect(callback.searchParams.has('code')).toBe(false);
					expect(callback.searchParams.has('error')).toBe(true);
				} else {
					expect(refused.response.ok).toBe(false);
					expect(
						Object.hasOwn(
							z.record(z.string(), z.unknown()).parse(await refused.response.json()),
							'code',
						),
					).toBe(false);
				}
			}),
		);
		const permitted = await code();
		const issued = await exchange(permitted);
		expect(issued.status).toBe(200);
		const token = z
			.object({
				access_token: z.string(),
				expires_in: z.number().positive().max(300),
				refresh_token: z.never().optional(),
			})
			.parse(await issued.json());
		const checked = await jwtVerify(
			token.access_token,
			createRemoteJWKSet(new URL('/api/auth/jwks', harness.issuer)),
			{ issuer: harness.issuer, audience: managementAudience },
		);
		expect(typeof checked.payload.sid).toBe('string');
		expect(checked.protectedHeader.typ).toBe('at+jwt');
		await noToken(await exchange(permitted));
		await noToken(
			await exchange(permitted, { grant_type: 'refresh_token', refresh_token: 'forbidden' }),
		);
		expect(
			(await harness.database.prepare('SELECT * FROM oauthClient ORDER BY clientId').all()).results,
		).toEqual(clientsBefore);
		expect(
			await (
				await harness.gateway(
					`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
				)
			).json(),
		).not.toHaveProperty(`member:${registeredClientId}`);
		expect(harness.effects).toHaveLength(0);
	} finally {
		await harness.close();
	}
}, 120_000);
