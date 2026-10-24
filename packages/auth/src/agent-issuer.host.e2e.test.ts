import { createRemoteJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { expectBasicClientAuthenticationRefusal } from '#auth/test-fixtures/client-authentication-refusal';
import {
	startLocalAuthHarness,
	organizationOne,
	organizationTwo,
	registrationRequestId,
	registeredClientId,
	agentAudience,
} from '#auth/test-fixtures/local-auth-harness';

let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
const registrationSchema = z.strictObject({
	kind: z.literal('registered'),
	clientId: z.string(),
	clientSecret: z.string(),
});

function managementPath(clientId?: string): string {
	return `/management/organizations/${organizationOne}/agents${clientId === undefined ? '' : `/${encodeURIComponent(clientId)}`}`;
}
async function register(owner: string): Promise<z.infer<typeof registrationSchema>> {
	const response = await harness.gateway(managementPath(), {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
		body: JSON.stringify({ requestId: registrationRequestId }),
	});
	expect(response.status).toBe(200);
	return registrationSchema.parse(await response.json());
}
async function tokenResponse(
	credentials: { readonly clientId: string; readonly clientSecret: string },
	changes: Readonly<Record<string, string>> = {},
): Promise<Response> {
	return harness.auth('/api/auth/oauth2/token', {
		method: 'POST',
		headers: {
			authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			scope: 'tool-portal:agent',
			resource: agentAudience,
			...changes,
		}),
	});
}
async function accessToken(credentials: {
	readonly clientId: string;
	readonly clientSecret: string;
}): Promise<string> {
	const response = await tokenResponse(credentials);
	expect(response.status).toBe(200);
	return z
		.object({
			access_token: z.string(),
			expires_in: z.number().positive().max(300),
			refresh_token: z.never().optional(),
		})
		.parse(await response.json()).access_token;
}
function expectNoIssuedCredentials(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) expectNoIssuedCredentials(item);
		return;
	}
	const object = z.record(z.string(), z.unknown()).safeParse(value);
	if (!object.success) return;
	for (const [key, child] of Object.entries(object.data)) {
		expect(
			[
				'access_token',
				'accessToken',
				'refresh_token',
				'refreshToken',
				'id_token',
				'idToken',
				'client_id',
				'client_secret',
				'clientId',
				'clientSecret',
			].includes(key),
		).toBe(false);
		expectNoIssuedCredentials(child);
	}
}
async function toolCall(token: string, correlation: string, secondHeap = false): Promise<Response> {
	return harness.gateway(
		'/mcp',
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'mcp_portal_call',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: correlation,
				method: 'tools/call',
				params: {
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
					},
					name: 'mcp_portal_call',
					arguments: {
						calls: [
							{
								id: correlation,
								namespace: 'proof-upstream',
								toolName: 'record_effect',
								arguments: { correlation },
							},
						],
					},
				},
			}),
		},
		secondHeap,
	);
}

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

// T3 observes actual local storage and protocol effects. External Google is controlled; hosted login/CPU are unverified.
describe('S1 real agent issuer through the Gateway', () => {
	beforeAll(async () => {
		harness = await startLocalAuthHarness();
	}, 60_000);
	afterAll(async () => {
		await harness?.close();
	});
	it('bootstrap: native S256 loopback creates the fixed owner client once with real owner cookie and audit', async () => {
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
	});
	it('agent: real HTTP registration, token and JWKS authorize exactly one O1 effect and zero O2 effects', async () => {
		const owner = await harness.ownerToken();
		const credentials = await register(owner);
		expect(credentials.clientId).toBe(registeredClientId);
		const rows = await harness.database
			.prepare(
				'SELECT clientId, grantTypes, clientCredentialsScopes, metadata, tokenEndpointAuthMethod FROM oauthClient WHERE clientId = ?',
			)
			.bind(credentials.clientId)
			.first();
		expect(rows).toMatchObject({
			clientId: registeredClientId,
			grantTypes: '["client_credentials"]',
			clientCredentialsScopes: '["tool-portal:agent"]',
			metadata: JSON.stringify({ kind: 'agent', organizationId: organizationOne }),
			tokenEndpointAuthMethod: 'client_secret_basic',
		});
		expect(
			(
				await harness.database
					.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
					.bind(credentials.clientId)
					.all()
			).results,
		).toEqual([{ resourceId: agentAudience }]);
		expect(
			(
				await harness.database
					.prepare(
						'SELECT phase FROM sign_in_audit WHERE request_id = ? AND change_kind = ? ORDER BY phase',
					)
					.bind(registrationRequestId, 'registered')
					.all()
			).results,
		).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
		const proof = await accessToken(credentials);
		const signed = await jwtVerify(
			proof,
			createRemoteJWKSet(new URL('/api/auth/jwks', harness.issuer)),
			{
				issuer: harness.issuer,
				audience: agentAudience,
			},
		);
		const claims = z
			.object({
				sub: z.literal(registeredClientId),
				client_id: z.literal(registeredClientId),
				azp: z.literal(registeredClientId),
				aud: z.literal(agentAudience),
				organization_id: z.literal(organizationOne),
				scope: z.literal('tool-portal:agent'),
				iat: z.number(),
				exp: z.number(),
			})
			.parse(signed.payload);
		expect(signed.protectedHeader.typ).toBe('at+jwt');
		expect(Object.hasOwn(signed.payload, 'sid')).toBe(false);
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
		const before = harness.effects.length;
		const correlation = crypto.randomUUID();
		expect((await toolCall(proof, correlation)).status).toBe(200);
		expect(harness.effects.slice(before)).toEqual([
			{ credential: 'Bearer organization-one-canary', arguments: { correlation } },
		]);
		expect(
			harness.effects.filter((effect) => effect.credential === 'Bearer organization-two-canary'),
		).toHaveLength(0);
		expect(
			await (
				await harness.gateway(
					`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
				)
			).json(),
		).toMatchObject({ [`agent:${registeredClientId}`]: { state: 'listed' } });
		async function foreignTargetState(): Promise<unknown> {
			return {
				client: await harness.database
					.prepare('SELECT * FROM oauthClient WHERE clientId = ?')
					.bind(registeredClientId)
					.first(),
				resources: (
					await harness.database
						.prepare('SELECT * FROM oauthClientResource WHERE clientId = ? ORDER BY resourceId')
						.bind(registeredClientId)
						.all()
				).results,
				admission: await Promise.all(
					[organizationOne, organizationTwo].map(
						async (organizationId: string): Promise<unknown> =>
							(
								await harness.gateway(
									`/__auth-proof?organization=${organizationId}&client=${registeredClientId}`,
								)
							).json(),
					),
				),
			};
		}
		const protectedBeforeForeign = await foreignTargetState();
		const effectsBeforeForeign = [...harness.effects];
		const foreign = await harness.gateway(
			`/management/organizations/${organizationTwo}/agents/${registeredClientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			},
		);
		expect(foreign.status).toBe(403);
		expectNoIssuedCredentials(await foreign.json());
		expect(await foreignTargetState()).toEqual(protectedBeforeForeign);
		expect(harness.effects).toEqual(effectsBeforeForeign);
	});
	it('agent: wrong grant, resource and dynamic registration never return a token or client', async () => {
		const credentials = await register(await harness.ownerToken());
		const codesBefore = await harness.database
			.prepare(
				"SELECT COUNT(*) AS count FROM verification WHERE json_valid(value) AND json_extract(value, '$.type') = 'authorization_code'",
			)
			.first();
		const authorization = new URL('/api/auth/oauth2/authorize', harness.issuer);
		authorization.search = new URLSearchParams({
			client_id: credentials.clientId,
			response_type: 'code',
			redirect_uri: harness.target.ownerCliRedirectUri,
			scope: 'tool-portal:agent',
			resource: agentAudience,
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
			state: crypto.randomUUID(),
		}).toString();
		const forbiddenCode = await harness.auth(authorization.toString(), {
			headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
		});
		expect(forbiddenCode.status).toBe(302);
		const refusedAuthorization = new URL(
			z.string().parse(forbiddenCode.headers.get('location')),
			harness.issuer,
		);
		expect(refusedAuthorization.searchParams.get('error')).toBe('unauthorized_client');
		expect(refusedAuthorization.searchParams.has('code')).toBe(false);
		expect(
			await harness.database
				.prepare(
					"SELECT COUNT(*) AS count FROM verification WHERE json_valid(value) AND json_extract(value, '$.type') = 'authorization_code'",
				)
				.first(),
		).toEqual(codesBefore);
		const denied = await Promise.all(
			[
				{ grant_type: 'refresh_token', refresh_token: 'unknown' },
				{ grant_type: 'authorization_code', code: 'unknown' },
				{ resource: 'https://other.invalid/mcp' },
			].map((changes) => tokenResponse(credentials, changes)),
		);
		expect(denied.every((response) => !response.ok)).toBe(true);
		const deniedBodies: unknown[] = await Promise.all(
			denied.map((response: Response): Promise<unknown> => response.json()),
		);
		for (const body of deniedBodies) expectNoIssuedCredentials(body);
		expect(deniedBodies[2]).toMatchObject({ error: 'invalid_target' });
		const clientsBeforeDynamic = (
			await harness.database.prepare('SELECT * FROM oauthClient ORDER BY clientId').all()
		).results;
		const dynamic = await harness.auth('/api/auth/oauth2/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'forbidden',
				grant_types: ['authorization_code'],
				response_types: ['code'],
				redirect_uris: [harness.target.ownerCliRedirectUri],
				token_endpoint_auth_method: 'none',
				application_type: 'native',
			}),
		});
		const clientsAfterDynamic = (
			await harness.database.prepare('SELECT * FROM oauthClient ORDER BY clientId').all()
		).results;
		expect(clientsAfterDynamic).toEqual(clientsBeforeDynamic);
		expect(clientsAfterDynamic).toHaveLength(clientsBeforeDynamic.length);
		expect(dynamic.ok).toBe(false);
		expectNoIssuedCredentials(await dynamic.json());
	});
	it('agent: failed disable keeps admission removed in two warm Gateway heaps and a later owner request completes it', async () => {
		const owner = await harness.ownerToken();
		const credentials = await register(owner);
		const proof = await accessToken(credentials);
		await toolCall(proof, 'warm-one');
		await toolCall(proof, 'warm-two', true);
		await harness.database.exec(
			`CREATE TRIGGER fail_agent_disable BEFORE UPDATE OF disabled ON oauthClient WHEN NEW.clientId = '${registeredClientId}' BEGIN SELECT RAISE(FAIL, 'controlled-disable-fault'); END;`,
		);
		try {
			const removal = await harness.gateway(managementPath(registeredClientId), {
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			});
			expect(removal.status).toBe(202);
			const count = harness.effects.length;
			expect((await toolCall(proof, 'removed-one')).status).toBe(401);
			expect((await toolCall(proof, 'removed-two', true)).status).toBe(401);
			expect(harness.effects).toHaveLength(count);
			expect((await tokenResponse(credentials)).status).toBe(200);
		} finally {
			await harness.database.exec('DROP TRIGGER fail_agent_disable');
		}
		const completed = await harness.gateway(managementPath(registeredClientId), {
			headers: { authorization: `Bearer ${owner}` },
		});
		expect(await completed.json()).toEqual({ kind: 'removed', clientId: registeredClientId });
		await expectBasicClientAuthenticationRefusal(await tokenResponse(credentials));
		expect(
			await (
				await harness.gateway(
					`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
				)
			).json(),
		).toMatchObject({
			[`agent:${registeredClientId}`]: { state: 'removed' },
			[`agent-retirement:${registeredClientId}`]: { kind: 'complete' },
		});
	});
});
