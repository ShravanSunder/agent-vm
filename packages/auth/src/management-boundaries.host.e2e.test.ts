import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import type { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import {
	startLocalAuthHarness,
	organizationOne,
	registrationRequestId,
	registeredClientId,
	agentAudience,
	managementAudience,
} from '#auth/test-fixtures/local-auth-harness';

let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
beforeAll(async () => {
	harness = await startLocalAuthHarness();
}, 60_000);
afterAll(async () => {
	await harness?.close();
});

async function protectedRows(): Promise<unknown> {
	return Promise.all([
		harness.database
			.prepare('SELECT clientId, disabled, metadata, grantTypes FROM oauthClient ORDER BY clientId')
			.all(),
		harness.database
			.prepare('SELECT clientId, resourceId FROM oauthClientResource ORDER BY clientId, resourceId')
			.all(),
		harness.database
			.prepare(
				'SELECT identifier, disabled, customClaims, allowedScopes FROM oauthResource ORDER BY identifier',
			)
			.all(),
		harness.database
			.prepare('SELECT id, clientId, userId, scopes FROM oauthConsent ORDER BY id')
			.all(),
		harness.database
			.prepare(
				'SELECT id, actor_user_id, request_id, phase, change_kind, target_id FROM sign_in_audit ORDER BY id',
			)
			.all(),
		harness
			.gateway(`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`)
			.then((response) => response.json()),
	]);
}

it('agent: every management boundary refuses real E10 and signed management no-sid identity before protected reads or effects', async () => {
	const owner = await harness.ownerToken();
	const person = z
		.object({ sub: z.string(), sid: z.string(), iat: z.number(), exp: z.number() })
		.parse(decodeJwt(owner));
	expect(person.exp - person.iat).toBeLessThanOrEqual(300);
	const endpoint = `/management/organizations/${organizationOne}/agents`;
	const registered = await harness.gateway(endpoint, {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
		body: JSON.stringify({ requestId: registrationRequestId }),
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
				binding.SIGN_IN.changeClient({
					token,
					operation: {
						kind: 'register',
						organizationId: organizationOne,
						requestId: crypto.randomUUID(),
					},
				}),
				binding.SIGN_IN.changeClient({
					token,
					operation: {
						kind: 'disable',
						organizationId: organizationOne,
						clientId: registeredClientId,
						requestId: crypto.randomUUID(),
					},
				}),
			]);
			expect(refused).toEqual([
				{ kind: 'refused', reason: 'not-owner' },
				{ kind: 'refused', reason: 'not-owner' },
			]);
		}),
	);
	expect(await protectedRows()).toEqual(before);
	const gatewayResponses = await Promise.all(
		[agent, withoutSid].flatMap((token) => [
			harness.gateway(endpoint, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId }),
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
	const resource = encodeURIComponent(agentAudience);
	// Enumerated from the installed provider's actual client/resource endpoint definitions.
	const routes = [
		...['get-session', 'list-sessions', 'list-accounts'].map((name) => ({
			method: 'GET',
			path: `/api/auth/${name}`,
		})),
		{ method: 'POST', path: '/api/auth/admin/oauth2/create-client' },
		{ method: 'PATCH', path: '/api/auth/admin/oauth2/update-client' },
		{ method: 'POST', path: '/api/auth/oauth2/public-client-prelogin' },
		...['create-client', 'update-client', 'delete-client', 'client/rotate-secret'].map((name) => ({
			method: 'POST',
			path: `/api/auth/oauth2/${name}`,
		})),
		...['get-client', 'get-clients', 'public-client'].map((name) => ({
			method: 'GET',
			path: `/api/auth/oauth2/${name}?client_id=${registeredClientId}`,
		})),
		...['get-consent', 'get-consents'].map((name) => ({
			method: 'GET',
			path: `/api/auth/oauth2/${name}?id=missing-consent`,
		})),
		...['update-consent', 'delete-consent'].map((name) => ({
			method: 'POST',
			path: `/api/auth/oauth2/${name}`,
		})),
		...[
			{ method: 'POST', suffix: '' },
			{ method: 'GET', suffix: '' },
			{ method: 'GET', suffix: `/${resource}` },
			{ method: 'PATCH', suffix: `/${resource}` },
			{ method: 'DELETE', suffix: `/${resource}` },
			{ method: 'POST', suffix: `/${resource}/clients/${registeredClientId}` },
			{ method: 'DELETE', suffix: `/${resource}/clients/${registeredClientId}` },
		].map(({ method, suffix }) => ({ method, path: `/api/auth/admin/oauth2/resources${suffix}` })),
		{ method: 'POST', path: '/api/auth/owner/bootstrap' },
	];
	const responses = await Promise.all(
		[agent, withoutSid].flatMap((token) =>
			routes.map((route) => {
				const body = JSON.stringify({
					client_id: registeredClientId,
					actor: person.sub,
					owner: true,
					organizationId: organizationOne,
				});
				return harness.auth(route.path, {
					method: route.method,
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
						'x-owner-id': person.sub,
						'x-organization-id': organizationOne,
					},
					...(route.method === 'GET' ? {} : { body }),
				});
			}),
		),
	);
	expect(
		responses.flatMap((response, index) =>
			[401, 403, 404].includes(response.status)
				? []
				: [{ path: routes[index % routes.length]?.path, status: response.status }],
		),
	).toEqual([]);
	await Promise.all(
		responses.map(async (response, index) => {
			const route = routes[index % routes.length];
			if (
				route?.path.startsWith('/api/auth/admin/') ||
				route?.path.startsWith('/api/auth/oauth2/')
			) {
				// This is the product fence's exact refusal, not a provider 404 for an absent route or row.
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({ error: 'not-found' });
			}
		}),
	);
	expect(await protectedRows()).toEqual(before);
	expect(harness.effects).toHaveLength(0);
	const ownerRead = await harness.gateway(`${endpoint}/${registeredClientId}`, {
		headers: { authorization: `Bearer ${owner}` },
	});
	expect(await ownerRead.json()).toEqual({ kind: 'listed', clientId: registeredClientId });
	const personAtAgentEdge = await harness.gateway('/mcp', {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}` },
	});
	expect(personAtAgentEdge.status).toBe(401);
	expect(await personAtAgentEdge.json()).toEqual({ error: 'not-an-agent' });
	const noHook = await harness.auth('/__auth-proof/no-hook');
	expect(noHook.status).toBe(200);
	expect(await noHook.json()).toEqual({ refused: true });
}, 120_000);
