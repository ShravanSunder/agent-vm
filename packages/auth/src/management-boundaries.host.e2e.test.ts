import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import type { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { expectNoIssuedCredentials } from '#auth/test-fixtures/credential-free-refusal';
import {
	startLocalAuthHarness,
	organizationOne,
	registrationRequestId,
	registeredClientId,
	agentAudience,
	managementAudience,
	workspaceOne,
} from '#auth/test-fixtures/local-auth-harness';
import {
	managementClientReadbackSql,
	managementAuditReadbackSql,
	requireManagementRefusalReadback,
} from '#auth/test-fixtures/management-refusal-readback';
import { installedProviderEndpointInventory } from '#auth/test-fixtures/provider-endpoint-inventory';

let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
beforeAll(async () => {
	harness = await startLocalAuthHarness();
}, 60_000);
afterAll(async () => {
	await harness?.close();
});

interface ManagementReadback {
	readonly protectedState: readonly unknown[];
	readonly auditRows: unknown;
}
async function protectedRows(): Promise<ManagementReadback> {
	const protectedState = await Promise.all([
		harness.database
			.prepare(managementClientReadbackSql)
			.all()
			.then((result) => result.results),
		harness.database
			.prepare('SELECT * FROM oauthClientResource ORDER BY clientId, resourceId')
			.all()
			.then((result) => result.results),
		harness.database
			.prepare('SELECT * FROM oauthResource ORDER BY identifier')
			.all()
			.then((result) => result.results),
		harness.database
			.prepare('SELECT * FROM oauthConsent ORDER BY id')
			.all()
			.then((result) => result.results),
		harness
			.gateway(`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`)
			.then((response) => response.json()),
	]);
	const auditRows = (await harness.database.prepare(managementAuditReadbackSql).all()).results;
	return { protectedState, auditRows };
}

it('agent: every management boundary refuses real E10 and signed management no-sid identity before protected reads or effects', async () => {
	const owner = await harness.ownerToken();
	const person = z
		.object({ sub: z.string(), sid: z.string(), iat: z.number(), exp: z.number() })
		.parse(decodeJwt(owner));
	expect(person.exp - person.iat).toBeLessThanOrEqual(300);
	const endpoint = `/management/workspaces/${workspaceOne}/agents`;
	const registered = await harness.gateway(endpoint, {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
		body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
	});
	expect(registered.status).toBe(200);
	const client = z
		.object({ clientId: z.literal(registeredClientId), clientSecret: z.string() })
		.parse(await registered.json());
	const minted = await harness.auth('/api/auth/oauth2/token', {
		method: 'POST',
		headers: {
			authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			resource: agentAudience,
			scope: 'tool-portal:agent',
		}),
	});
	expect(minted.status).toBe(200);
	const agent = z.object({ access_token: z.string() }).parse(await minted.json()).access_token;
	const negative = await harness.auth('/api/auth/__proof/without-sid', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ subject: person.sub, clientId: person.sid }),
	});
	expect(negative.status).toBe(200);
	const withoutSid = z.object({ token: z.string() }).parse(await negative.json()).token;
	const checked = await jwtVerify(
		withoutSid,
		createRemoteJWKSet(new URL('/api/auth/jwks', harness.issuer)),
		{ issuer: harness.issuer, audience: managementAudience },
	);
	expect(decodeProtectedHeader(withoutSid).typ).toBe('at+jwt');
	expect(Object.hasOwn(checked.payload, 'sid')).toBe(false);
	const before = await protectedRows();
	const storedCredentialHashes = z
		.array(z.object({ clientSecret: z.string().nullable() }))
		.parse(before.protectedState[0])
		.flatMap((row) => (row.clientSecret === null ? [] : [row.clientSecret]));
	async function requireUnchangedProtectedState(): Promise<void> {
		const after = await protectedRows();
		requireManagementRefusalReadback({
			beforeProtected: before.protectedState,
			afterProtected: after.protectedState,
			beforeAudit: before.auditRows,
			afterAudit: after.auditRows,
			attributableActors: [person.sub, client.clientId],
			forbiddenValues: [
				owner,
				agent,
				withoutSid,
				client.clientSecret,
				harness.cookie(),
				...storedCredentialHashes,
			],
		});
	}

	const binding = await harness.miniflare.getBindings<{
		readonly SIGN_IN: ReturnType<typeof createSignInManagementBinding>;
	}>('gateway-one');
	// This calls the real named RPC binding. No HTTP route or 404 can satisfy these oracles.
	expect(await binding.SIGN_IN.isLiveOwner({ token: owner, organizationId: organizationOne })).toBe(
		true,
	);
	await Promise.all(
		[agent, withoutSid].map(async (token) => {
			expect(await binding.SIGN_IN.isLiveOwner({ token, organizationId: organizationOne })).toBe(
				false,
			);
			expect(
				await binding.SIGN_IN.ownsAgentClient({
					token,
					organizationId: organizationOne,
					clientId: registeredClientId,
				}),
			).toBe(false);
			const refused = await Promise.all([
				binding.SIGN_IN.registerAndLink({
					token,
					workspaceId: workspaceOne,
					organizationId: organizationOne,
					requestId: crypto.randomUUID(),
				}),
				binding.SIGN_IN.link({
					token,
					organizationId: organizationOne,
					workspaceId: workspaceOne,
					clientId: registeredClientId,
					requestId: crypto.randomUUID(),
				}),
				binding.SIGN_IN.unlink({
					token,
					organizationId: organizationOne,
					workspaceId: workspaceOne,
					clientId: registeredClientId,
					requestId: crypto.randomUUID(),
				}),
				binding.SIGN_IN.disable({
					token,
					organizationId: organizationOne,
					clientId: registeredClientId,
					requestId: crypto.randomUUID(),
				}),
			]);
			expect(refused).toEqual([
				{ kind: 'refused', reason: 'not-owner' },
				{ kind: 'refused', reason: 'not-owner' },
				{ kind: 'refused', reason: 'not-owner' },
				{ kind: 'refused', reason: 'not-owner' },
			]);
		}),
	);
	await requireUnchangedProtectedState();
	const gatewayResponses = await Promise.all(
		[agent, withoutSid].flatMap((token) => [
			harness.gateway(endpoint, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
			}),
			harness.gateway(`${endpoint}/${registeredClientId}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
			harness.gateway(`${endpoint}/${registeredClientId}`, {
				method: 'DELETE',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			}),
		]),
	);
	expect(gatewayResponses.map((response) => response.status)).toEqual([
		403, 403, 403, 403, 403, 403,
	]);
	const gatewayBodies: readonly unknown[] = await Promise.all(
		gatewayResponses.map((response: Response): Promise<unknown> => response.json()),
	);
	// Independent S1 contract: do not filter this inventory through the product's allowlist.
	const publicProviderPaths = new Set([
		'/api/auth/sign-in/social',
		'/api/auth/callback/google',
		'/api/auth/callback/github',
		'/api/auth/oauth2/authorize',
		'/api/auth/oauth2/token',
		'/api/auth/oauth2/introspect',
		'/api/auth/jwks',
		'/api/auth/.well-known/oauth-authorization-server',
		'/api/auth/.well-known/openid-configuration',
	]);
	const { httpRoutes: installedRoutes, noHttpPathApis } = await installedProviderEndpointInventory(
		harness.miniflare,
	);
	expect(noHttpPathApis).toEqual([
		{ endpointName: 'setPassword', serverOnly: true },
		{ endpointName: 'signJWT', serverOnly: true },
		{ endpointName: 'verifyJWT', serverOnly: true },
	]);
	expect(installedRoutes.length).toBeGreaterThan(0);
	for (const requiredPath of [
		'/api/auth/get-session',
		'/api/auth/list-sessions',
		'/api/auth/list-accounts',
		'/api/auth/revoke-other-sessions',
		'/api/auth/sign-out',
		'/api/auth/get-access-token',
	])
		expect(installedRoutes.some((route) => route.path === requiredPath)).toBe(true);
	const routes = installedRoutes
		.map((route) => ({
			...route,
			path: route.path.replace(/:([^/]+)/gu, (_parameter: string, name: string): string =>
				encodeURIComponent(name.includes('client') ? registeredClientId : `missing-${name}`),
			),
		}))
		.filter((route) => !publicProviderPaths.has(route.path));
	const cookieSnapshot = harness.cookie();
	const observations = await Promise.all(
		[agent, withoutSid].flatMap((token) =>
			[false, true].flatMap((withCookie) =>
				routes.map(async (route) => {
					const response = await harness.auth(route.path, {
						method: route.method,
						headers: {
							authorization: `Bearer ${token}`,
							cookie: withCookie ? cookieSnapshot : '',
							'content-type': 'application/json',
							'x-owner-id': person.sub,
							'x-organization-id': organizationOne,
						},
						...(['GET', 'HEAD'].includes(route.method)
							? {}
							: {
									body: JSON.stringify({
										client_id: registeredClientId,
										actor: person.sub,
										owner: true,
										organizationId: organizationOne,
									}),
								}),
					});
					const body: unknown = route.method === 'HEAD' ? null : await response.json();
					return {
						...route,
						withCookie,
						identity: token === agent ? 'E10' : 'no-sid',
						status: response.status,
						exactRefusal:
							route.method === 'HEAD' ||
							z.strictObject({ error: z.literal('not-found') }).safeParse(body).success,
					};
				}),
			),
		),
	);
	expect(observations.filter((observation) => observation.status !== 404)).toEqual([]);
	expect(observations.filter((observation) => !observation.exactRefusal)).toEqual([]);
	await Promise.all(
		[agent, withoutSid].flatMap((token) =>
			[false, true].map(async (withCookie) => {
				const refusedBootstrap = await harness.auth('/api/auth/owner/bootstrap', {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						cookie: withCookie ? cookieSnapshot : '',
						'content-type': 'application/json',
					},
					body: '{}',
				});
				expect(refusedBootstrap.status).toBe(403);
			}),
		),
	);
	await requireUnchangedProtectedState();
	expect(harness.effects).toHaveLength(0);
	for (const body of gatewayBodies) expectNoIssuedCredentials(body);
	const ownerRead = await harness.gateway(`${endpoint}/${registeredClientId}`, {
		headers: { authorization: `Bearer ${owner}` },
	});
	expect(await ownerRead.json()).toEqual({
		kind: 'member',
		clientId: registeredClientId,
		workspaceId: workspaceOne,
	});
	const personAtAgentEdge = await harness.gateway(`/workspaces/${workspaceOne}/mcp`, {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}` },
	});
	expect(personAtAgentEdge.status).toBe(401);
	expect(await personAtAgentEdge.json()).toEqual({ error: 'wrong-audience' });
	const noHook = await harness.auth('/__auth-proof/no-hook');
	expect(noHook.status).toBe(200);
	expect(await noHook.json()).toEqual({ refused: true });
}, 120_000);
