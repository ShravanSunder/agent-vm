import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

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
		expect(token.length).toBeGreaterThan(0);
		const before = await harness.database
			.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?')
			.bind(harness.target.ownerCliClientId)
			.all();
		expect(before.results).toHaveLength(1);
		const repeated = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(repeated.status).toBe(200);
		expect(
			(
				await harness.database
					.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?')
					.bind(harness.target.ownerCliClientId)
					.all()
			).results,
		).toEqual(before.results);
		const denied = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: '{}',
		});
		expect(denied.status).toBe(403);
		expect(
			(await harness.database.prepare('SELECT * FROM deployment_owner').all()).results,
		).toHaveLength(1);
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
		const proof = await accessToken(credentials);
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
		const foreign = await harness.gateway(
			`/management/organizations/${organizationTwo}/agents/${registeredClientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			},
		);
		expect(foreign.status).toBe(403);
	});
	it('agent: wrong grant, resource and dynamic registration never return a token or client', async () => {
		const credentials = await register(await harness.ownerToken());
		const denied = await Promise.all(
			[
				{ grant_type: 'refresh_token', refresh_token: 'unknown' },
				{ grant_type: 'authorization_code', code: 'unknown' },
				{ resource: 'https://other.invalid/mcp' },
			].map((changes) => tokenResponse(credentials, changes)),
		);
		expect(denied.every((response) => !response.ok)).toBe(true);
		const dynamic = await harness.auth('/api/auth/oauth2/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ client_name: 'forbidden' }),
		});
		expect(dynamic.ok).toBe(false);
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
		expect((await tokenResponse(credentials)).status).toBe(400);
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
