import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { createSignInProvider } from '#auth/better-auth-provider/provider-configuration';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';
import { startLocalAuthHarness } from '#auth/test-fixtures/local-auth-harness';

it('agent: refuses client self-key rotation at the provider and public entry without changing stored credentials', async () => {
	// Arrange: real provider and D1, with a valid public key body that reaches the rotation gate.
	const rotationHarness = await startLocalAuthHarness();
	try {
		const bindings = await rotationHarness.miniflare.getBindings<AuthWorkerEnv>('sign-in');
		const provider = createSignInProvider({
			...signInWorkerConfiguration(bindings),
			authority: { kind: 'public' },
			requestState: { createdUserIds: [], issuedSessions: [] },
		});
		const { publicKey } = await generateKeyPair('EdDSA');
		const body = JSON.stringify({
			client_assertion: 'synthetic-assertion',
			client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
			jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: 'rotation-test' }] },
		});
		const readClients = async (): Promise<readonly Record<string, unknown>[]> =>
			(await rotationHarness.database.prepare('SELECT * FROM oauthClient ORDER BY clientId').all())
				.results;
		const before = await readClients();
		const pathname = '/api/auth/oauth2/client/rotate-keys';
		const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

		// Act: bypass our public-route fence once to observe the provider's own disabled gate.
		const providerResponse = await provider.handler(
			new Request(`${rotationHarness.issuer}${pathname}`, init),
		);
		const publicResponse = await rotationHarness.auth(pathname, init);

		// Assert: enabling self-rotation would reach assertion authentication instead of this refusal.
		expect(providerResponse.status).toBe(403);
		expect(await providerResponse.json()).toMatchObject({
			error: 'access_denied',
			error_description: 'Client key rotation is disabled',
		});
		expect(publicResponse.status).toBe(404);
		expect(await readClients()).toEqual(before);
	} finally {
		await rotationHarness.close();
	}
});
it.each([
	{ scenario: 'a verified non-owner', email: 'first-arrival@example.invalid', verified: true },
	{ scenario: 'an unverified configured owner', email: 'owner@example.invalid', verified: false },
])(
	'bootstrap: refuses $scenario first arrival before admitting the configured owner',
	async ({ email, verified }: { readonly email: string; readonly verified: boolean }) => {
		const emptyDeployment = await startLocalAuthHarness();
		try {
			// Arrange: real migrations and usable public keys, with no admitted Person or native client.
			const jwks = await emptyDeployment.auth('/api/auth/jwks');
			expect(jwks.status).toBe(200);
			z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.string() })).min(1) }).parse(
				await jwks.json(),
			);
			async function identityRows(): Promise<readonly unknown[]> {
				return Promise.all(
					[
						'SELECT id FROM user',
						'SELECT id FROM account',
						'SELECT id FROM session',
						'SELECT user_id FROM deployment_owner',
						'SELECT clientId FROM oauthClient',
						'SELECT person_id FROM allowed_email WHERE person_id IS NOT NULL',
					].map(
						async (sql: string): Promise<unknown> =>
							(await emptyDeployment.database.prepare(sql).all()).results,
					),
				);
			}
			expect(await identityRows()).toEqual([[], [], [], [], [], []]);
			// Act/Assert: provider protocol stays real; a rejected first arrival leaves no identity authority.
			await expect(emptyDeployment.personToken(email, verified)).rejects.toThrow();
			expect(await identityRows()).toEqual([[], [], [], [], [], []]);
			expect(emptyDeployment.effects).toHaveLength(0);
			// An allowed later arrival must still complete the delivered CLI and become the sole owner.
			const owner = await emptyDeployment.ownerToken();
			const signed = await jwtVerify(
				owner,
				createRemoteJWKSet(new URL('/api/auth/jwks', emptyDeployment.issuer)),
				{
					issuer: emptyDeployment.issuer,
					audience: emptyDeployment.target.managementAudience,
				},
			);
			const personId = z.string().parse(signed.payload.sub);
			expect(
				(await emptyDeployment.database.prepare('SELECT user_id FROM deployment_owner').all())
					.results,
			).toEqual([{ user_id: personId }]);
			expect(
				(
					await emptyDeployment.database
						.prepare('SELECT email, person_id FROM allowed_email WHERE person_id IS NOT NULL')
						.all()
				).results,
			).toEqual([{ email: 'owner@example.invalid', person_id: personId }]);
			expect(
				(await emptyDeployment.database.prepare('SELECT clientId FROM oauthClient').all()).results,
			).toEqual([{ clientId: emptyDeployment.target.ownerCliClientId }]);
		} finally {
			await emptyDeployment.close();
		}
	},
	120_000,
);

it('bootstrap: native S256 loopback creates the fixed owner client once with real owner cookie and audit', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const token = await harness.ownerToken();
		const verified = await jwtVerify(
			token,
			createRemoteJWKSet(new URL('/api/auth/jwks', harness.issuer)),
			{ issuer: harness.issuer, audience: harness.target.managementAudience },
		);
		const person = z
			.object({
				sub: z.string(),
				sid: z.string(),
				iat: z.number(),
				exp: z.number(),
				aud: z.literal(harness.target.managementAudience),
				client_id: z.literal(harness.target.ownerCliClientId),
			})
			.parse(verified.payload);
		expect(verified.protectedHeader.typ).toBe('at+jwt');
		expect(person.exp - person.iat).toBeLessThanOrEqual(300);
		expect(
			(await harness.database.prepare('SELECT user_id FROM deployment_owner').all()).results,
		).toEqual([{ user_id: person.sub }]);
		expect(
			await harness.database
				.prepare('SELECT id, userId FROM session WHERE id = ?')
				.bind(person.sid)
				.first(),
		).toEqual({ id: person.sid, userId: person.sub });
		const client = z
			.object({
				clientId: z.literal(harness.target.ownerCliClientId),
				clientSecret: z.null(),
				tokenEndpointAuthMethod: z.literal('none'),
				applicationType: z.literal('native'),
				grantTypes: z.string(),
				responseTypes: z.string(),
				redirectUris: z.string(),
				scopes: z.string(),
				requirePKCE: z.literal(1),
			})
			.parse(
				await harness.database
					.prepare('SELECT * FROM oauthClient WHERE clientId = ?')
					.bind(harness.target.ownerCliClientId)
					.first(),
			);
		expect(JSON.parse(client.grantTypes)).toEqual(['authorization_code']);
		expect(JSON.parse(client.responseTypes)).toEqual(['code']);
		expect(JSON.parse(client.redirectUris)).toEqual([harness.target.ownerCliRedirectUri]);
		expect(JSON.parse(client.scopes)).toEqual(['tool-portal:management']);
		expect(
			(
				await harness.database
					.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
					.bind(client.clientId)
					.all()
			).results,
		).toEqual([{ resourceId: harness.target.managementAudience }]);
		expect(
			(
				await harness.database
					.prepare(
						'SELECT phase, actor_user_id FROM sign_in_audit WHERE request_id = ? ORDER BY phase',
					)
					.bind(`owner-cli:${client.clientId}`)
					.all()
			).results,
		).toEqual([
			{ phase: 'intent', actor_user_id: person.sub },
			{ phase: 'outcome', actor_user_id: person.sub },
		]);
		expect(
			(await harness.database.prepare('SELECT id FROM oauthRefreshToken').all()).results,
		).toHaveLength(0);
		async function protectedBootstrapRows(): Promise<unknown> {
			const queryResults = await Promise.all([
				harness.database.prepare('SELECT * FROM oauthClient ORDER BY clientId').all(),
				harness.database
					.prepare('SELECT * FROM oauthClientResource ORDER BY clientId, resourceId')
					.all(),
				harness.database.prepare('SELECT * FROM deployment_owner').all(),
			]);
			return queryResults.map((queryResult) => queryResult.results);
		}
		const before = await protectedBootstrapRows();
		const repeated = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(repeated.status).toBe(200);
		expect(await protectedBootstrapRows()).toEqual(before);
		const denied = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: '{}',
		});
		expect(denied.status).toBe(403);
		expect(await protectedBootstrapRows()).toEqual(before);
	} finally {
		await harness.close();
	}
});
