import { createRemoteJWKSet, jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import type { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { expectNoIssuedCredentials } from '#auth/test-fixtures/credential-free-refusal';
import {
	startLocalAuthHarness,
	workspaceOne,
	workspaceTwo,
	workspaceThree,
	workspaceAudience,
	organizationOne,
	registrationRequestId,
	registeredClientId,
} from '#auth/test-fixtures/local-auth-harness';
import {
	addWorkspaceAgent,
	agentCredentialSchema,
	callWorkspaceTool,
	workspaceToken,
	workspaceTokenResponse,
} from '#auth/test-fixtures/workspace-agent-proof';

it('agent: one real issuer client keeps two workspace links, removes only W1, and retires without unlinking W2', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const registered = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registered.status).toBe(200);
		const registration: unknown = await registered.json();
		expect(registration).toMatchObject({
			kind: 'registered',
			clientId: registeredClientId,
			workspaceId: workspaceOne,
			resource: workspaceAudience(workspaceOne),
		});
		const credential = agentCredentialSchema.parse(registration);
		const secretBeforeLink = await harness.database
			.prepare('SELECT clientSecret FROM oauthClient WHERE clientId = ?')
			.bind(credential.clientId)
			.first();
		const linked = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceTwo,
			requestId: crypto.randomUUID(),
			clientId: credential.clientId,
		});
		expect(linked.status).toBe(200);
		const linkResult: unknown = await linked.json();
		expect(linkResult).toEqual({
			kind: 'linked',
			clientId: credential.clientId,
			workspaceId: workspaceTwo,
			resource: workspaceAudience(workspaceTwo),
		});
		// A link result identifies the existing client; it must not carry a secret or token.
		expect(linkResult).not.toHaveProperty('clientSecret');
		expect(linkResult).not.toHaveProperty('client_secret');
		expect(linkResult).not.toHaveProperty('access_token');
		expect(
			await harness.database
				.prepare('SELECT clientSecret FROM oauthClient WHERE clientId = ?')
				.bind(credential.clientId)
				.first(),
		).toEqual(secretBeforeLink);
		const links = async (): Promise<unknown> =>
			(
				await harness.database
					.prepare(
						'SELECT resourceId FROM oauthClientResource WHERE clientId = ? ORDER BY resourceId',
					)
					.bind(credential.clientId)
					.all()
			).results;
		expect(await links()).toEqual(
			[workspaceOne, workspaceTwo].map((workspaceId) => ({
				resourceId: workspaceAudience(workspaceId),
			})),
		);
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				const resource = await harness.database
					.prepare(
						'SELECT identifier, metadata, allowedScopes, customClaims FROM oauthResource WHERE identifier = ?',
					)
					.bind(workspaceAudience(workspaceId))
					.first();
				expect(resource).toMatchObject({
					identifier: workspaceAudience(workspaceId),
					metadata: JSON.stringify({
						kind: 'workspace',
						organizationId: organizationOne,
						workspaceId,
					}),
					allowedScopes: '["tool-portal:agent"]',
					customClaims: null,
				});
			}),
		);
		const jwks = createRemoteJWKSet(new URL('/api/auth/jwks', harness.issuer));
		const w1 = await workspaceToken({ harness, credential, workspaceId: workspaceOne });
		const w2 = await workspaceToken({ harness, credential, workspaceId: workspaceTwo });
		await Promise.all(
			[
				{ token: w1, workspaceId: workspaceOne },
				{ token: w2, workspaceId: workspaceTwo },
			].map(async ({ token, workspaceId }): Promise<void> => {
				const signed = await jwtVerify(token, jwks, {
					issuer: harness.issuer,
					audience: workspaceAudience(workspaceId),
				});
				expect(signed.payload).toMatchObject({
					sub: credential.clientId,
					client_id: credential.clientId,
					organization_id: organizationOne,
					workspace_id: workspaceId,
					aud: workspaceAudience(workspaceId),
				});
				expect(signed.protectedHeader.typ).toBe('at+jwt');
				expect(signed.payload).not.toHaveProperty('sid');
			}),
		);
		const before = harness.effects.length;
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceOne,
					token: w1,
					correlation: 'wcut-w1',
				})
			).status,
		).toBe(200);
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: w2,
					correlation: 'wcut-w2',
				})
			).status,
		).toBe(200);
		expect(harness.effects.slice(before)).toEqual([
			{ credential: 'Bearer organization-one-canary', arguments: { correlation: 'wcut-w1' } },
			{ credential: 'Bearer workspace-two-canary', arguments: { correlation: 'wcut-w2' } },
		]);
		const effectsBeforeCross = [...harness.effects];
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: w1,
					correlation: 'cross-w1-w2',
				})
			).status,
		).toBe(401);
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceThree,
					token: w1,
					correlation: 'cross-w1-w3',
				})
			).status,
		).toBe(401);
		expect(harness.effects).toEqual(effectsBeforeCross);
		async function protectedWorkspaceState(): Promise<unknown> {
			return Promise.all([
				...[
					'SELECT * FROM oauthClient ORDER BY clientId',
					'SELECT * FROM oauthResource ORDER BY identifier',
					'SELECT * FROM oauthClientResource ORDER BY clientId, resourceId',
				].map(async (sql): Promise<unknown> => (await harness.database.prepare(sql).all()).results),
				...[workspaceOne, workspaceTwo, workspaceThree].map(
					async (workspaceId): Promise<unknown> =>
						(
							await harness.gateway(
								`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
							)
						).json(),
				),
			]);
		}
		const beforeForeign = await protectedWorkspaceState();
		const beforeForeignEffects = [...harness.effects];
		const foreign = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceThree,
			requestId: crypto.randomUUID(),
			clientId: credential.clientId,
		});
		expect(foreign.status).toBe(403);
		expectNoIssuedCredentials(await foreign.json());
		expect(await protectedWorkspaceState()).toEqual(beforeForeign);
		expect(harness.effects).toEqual(beforeForeignEffects);
		const foreignToken = await workspaceTokenResponse({
			harness,
			credential,
			workspaceId: workspaceThree,
		});
		expect(foreignToken.status).toBe(400);
		const foreignTokenBody: unknown = await foreignToken.json();
		expect(foreignTokenBody).toMatchObject({ error: 'invalid_target' });
		expectNoIssuedCredentials(foreignTokenBody);
		const unlinkRequestId = crypto.randomUUID();
		const removed = await harness.gateway(
			`/management/workspaces/${workspaceOne}/agents/${credential.clientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: unlinkRequestId }),
			},
		);
		expect(await removed.json()).toEqual({
			kind: 'removed',
			clientId: credential.clientId,
			workspaceId: workspaceOne,
		});
		const beforeRemovedW1Call = [...harness.effects];
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceOne,
					token: w1,
					correlation: 'removed-w1',
				})
			).status,
		).toBe(401);
		expect(
			await (
				await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })
			).json(),
		).toMatchObject({ error: 'invalid_target' });
		expect(harness.effects).toEqual(beforeRemovedW1Call);
		const newW2 = await workspaceToken({ harness, credential, workspaceId: workspaceTwo });
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: newW2,
					correlation: 'new-w2-after-w1',
				})
			).status,
		).toBe(200);
		expect(harness.effects.slice(beforeRemovedW1Call.length)).toEqual([
			{
				credential: 'Bearer workspace-two-canary',
				arguments: { correlation: 'new-w2-after-w1' },
			},
		]);
		expect(await links()).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		const afterUnlinkMembership = await Promise.all(
			[workspaceOne, workspaceTwo].map(
				async (workspaceId): Promise<unknown> =>
					(
						await harness.gateway(
							`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
						)
					).json(),
			),
		);
		expect(afterUnlinkMembership).toEqual([
			{
				[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
				[`member-removal:${credential.clientId}`]: {
					kind: 'complete',
					operation: 'unlink',
					requestId: unlinkRequestId,
				},
			},
			{ [`member:${credential.clientId}`]: { state: 'member', persona: 'operator' } },
		]);

		expect(
			await harness.database
				.prepare('SELECT COALESCE(disabled, 0) AS disabled FROM oauthClient WHERE clientId = ?')
				.bind(credential.clientId)
				.first(),
		).toMatchObject({ disabled: 0 });
		const retired = await harness.gateway(
			`/management/organizations/${organizationOne}/agents/${credential.clientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			},
		);
		expect(await retired.json()).toEqual({ kind: 'removed', clientId: credential.clientId });
		const beforeRetiredCalls = [...harness.effects];
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: newW2,
					correlation: 'retired-w2',
				})
			).status,
		).toBe(401);
		expect(
			await (
				await workspaceTokenResponse({ harness, credential, workspaceId: workspaceTwo })
			).json(),
		).toMatchObject({ error: 'invalid_client' });
		expect(harness.effects).toEqual(beforeRetiredCalls);
		// Global retirement disables without unlinking: W2's E11 remains a historical link.
		expect(await links()).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		const changes = (
			await harness.database
				.prepare(
					"SELECT phase FROM sign_in_audit WHERE kind = 'client-link-changed' AND change_kind = 'unlinked' ORDER BY phase",
				)
				.all()
		).results;
		expect(changes).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
	} finally {
		await harness.close();
	}
}, 120_000);

it('agent: a real zero-link client can be disabled through the named port without a workspace field', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const binding = await harness.miniflare.getBindings<{
			readonly SIGN_IN: ReturnType<typeof createSignInManagementBinding>;
		}>('gateway-one');
		const registered = await binding.SIGN_IN.registerAndLink({
			token: owner,
			organizationId: organizationOne,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registered.kind).toBe('registered');
		if (registered.kind !== 'registered') throw new Error('Named registration did not complete');
		const unlinked = await binding.SIGN_IN.unlink({
			token: owner,
			organizationId: organizationOne,
			workspaceId: workspaceOne,
			clientId: registered.clientId,
			requestId: crypto.randomUUID(),
		});
		expect(unlinked.kind).toBe('unlinked');
		expect(
			(
				await harness.database
					.prepare('SELECT * FROM oauthClientResource WHERE clientId = ?')
					.bind(registered.clientId)
					.all()
			).results,
		).toEqual([]);
		expect(
			await binding.SIGN_IN.ownsAgentClient({
				token: owner,
				organizationId: organizationOne,
				clientId: registered.clientId,
			}),
		).toBe(true);
		const disabled = await binding.SIGN_IN.disable({
			token: owner,
			organizationId: organizationOne,
			clientId: registered.clientId,
			requestId: crypto.randomUUID(),
		});
		expect(disabled).toEqual({ kind: 'disabled', clientId: registered.clientId });
		expect(
			await harness.database
				.prepare('SELECT COALESCE(disabled, 0) AS disabled FROM oauthClient WHERE clientId = ?')
				.bind(registered.clientId)
				.first(),
		).toMatchObject({ disabled: 1 });
	} finally {
		await harness.close();
	}
});

it('agent: a forced cross-organization resource link is refused before signing', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const registration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registration.status).toBe(200);
		const credential = agentCredentialSchema.parse(await registration.json());
		const foreignRegistration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceThree,
			requestId: crypto.randomUUID(),
		});
		expect(foreignRegistration.status).toBe(200);
		await harness.database
			.prepare(
				'INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt) VALUES (?, ?, ?, ?)',
			)
			.bind(crypto.randomUUID(), credential.clientId, workspaceAudience(workspaceThree), Date.now())
			.run();
		expect(
			await harness.database
				.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ? AND resourceId = ?')
				.bind(credential.clientId, workspaceAudience(workspaceThree))
				.first(),
		).toEqual({ resourceId: workspaceAudience(workspaceThree) });
		const control = `/__auth-proof/hold/`;
		await harness.auth(`${control}arm?client=${credential.clientId}`, { method: 'POST' });
		try {
			const refused = await workspaceTokenResponse({
				harness,
				credential,
				workspaceId: workspaceThree,
			});
			expect(refused.status).toBe(400);
			const body: unknown = await refused.json();
			expect(body).toMatchObject({ error: 'invalid_target' });
			expectNoIssuedCredentials(body);
			expect(
				await (await harness.auth(`${control}status?client=${credential.clientId}`)).json(),
			).toEqual({ armed: true, observed: false });
			expect(harness.effects).toEqual([]);
		} finally {
			await harness.auth(`${control}release?client=${credential.clientId}`, { method: 'POST' });
		}
	} finally {
		await harness.close();
	}
});

it('agent: an authentic legacy Worker audience without workspace identity cannot enter any workspace', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const registration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registration.status).toBe(200);
		const credential = agentCredentialSchema.parse(await registration.json());
		const response = await harness.auth('/api/auth/__proof/legacy-agent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clientId: credential.clientId, organizationId: organizationOne }),
		});
		expect(response.status).toBe(200);
		const { token } = z.object({ token: z.string() }).parse(await response.json());
		const signed = await jwtVerify(
			token,
			createRemoteJWKSet(new URL('/api/auth/jwks', harness.issuer)),
			{ issuer: harness.issuer, audience: 'https://portal-test.invalid/mcp' },
		);
		expect(signed.payload).toMatchObject({
			client_id: credential.clientId,
			organization_id: organizationOne,
			scope: 'tool-portal:agent',
		});
		expect(signed.payload).not.toHaveProperty('workspace_id');
		const effectsBefore = [...harness.effects];
		await Promise.all(
			[workspaceOne, workspaceTwo, workspaceThree].map(async (workspaceId): Promise<void> => {
				expect(
					(
						await callWorkspaceTool({
							harness,
							workspaceId,
							token,
							correlation: 'legacy-agent-refusal',
						})
					).status,
				).toBe(401);
			}),
		);
		expect(harness.effects).toEqual(effectsBefore);
	} finally {
		await harness.close();
	}
});
