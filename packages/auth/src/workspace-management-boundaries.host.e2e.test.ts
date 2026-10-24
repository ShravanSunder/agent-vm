import { expect, it } from 'vitest';
import { z } from 'zod';

import type { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { expectNoIssuedCredentials } from '#auth/test-fixtures/credential-free-refusal';
import {
	startLocalAuthHarness,
	workspaceOne,
	workspaceTwo,
	workspaceAudience,
	organizationOne,
	organizationTwo,
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

it('agent: a pending W1 unlink refuses warm calls until retry while a new W2 token still works', async () => {
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
		const credential = agentCredentialSchema.parse(await registered.json());
		expect(
			(
				await addWorkspaceAgent({
					harness,
					owner,
					workspaceId: workspaceTwo,
					clientId: credential.clientId,
					requestId: crypto.randomUUID(),
				})
			).status,
		).toBe(200);
		const old = await workspaceToken({ harness, credential, workspaceId: workspaceOne });
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceOne,
					token: old,
					correlation: 'warm-before-unlink',
				})
			).status,
		).toBe(200);
		await harness.database.exec(
			`CREATE TRIGGER fail_workspace_unlink BEFORE DELETE ON oauthClientResource WHEN OLD.clientId = '${registeredClientId}' AND OLD.resourceId = '${workspaceAudience(workspaceOne)}' BEGIN SELECT RAISE(FAIL, 'controlled-unlink-fault'); END;`,
		);
		const endpoint = `/management/workspaces/${workspaceOne}/agents/${credential.clientId}`;
		const operation = {
			method: 'DELETE',
			headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
			body: JSON.stringify({ requestId: crypto.randomUUID() }),
		};
		try {
			const pending = await harness.gateway(endpoint, operation);
			expect(pending.status).toBe(202);
			expect(await pending.json()).toEqual({
				kind: 'removal-pending',
				clientId: credential.clientId,
			});
			const before = [...harness.effects];
			expect(
				(
					await callWorkspaceTool({
						harness,
						workspaceId: workspaceOne,
						token: old,
						correlation: 'pending-unlink-refuses',
					})
				).status,
			).toBe(401);
			expect(harness.effects).toEqual(before);
			// The named between-writes gap is issuance, not admission: link deletion really failed.
			expect(
				(await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })).status,
			).toBe(200);
		} finally {
			await harness.database.exec('DROP TRIGGER fail_workspace_unlink');
		}
		const completed = await harness.gateway(endpoint, {
			headers: { authorization: `Bearer ${owner}` },
		});
		expect(await completed.json()).toEqual({
			kind: 'removed',
			clientId: credential.clientId,
			workspaceId: workspaceOne,
		});
		expect(
			await (
				await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })
			).json(),
		).toMatchObject({ error: 'invalid_target' });
		const w2 = await workspaceToken({ harness, credential, workspaceId: workspaceTwo });
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: w2,
					correlation: 'other-workspace-after-unlink',
				})
			).status,
		).toBe(200);
		expect(harness.effects.at(-1)).toEqual({
			credential: 'Bearer workspace-two-canary',
			arguments: { correlation: 'other-workspace-after-unlink' },
		});
		expect(
			(
				await harness.database
					.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
					.bind(credential.clientId)
					.all()
			).results,
		).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		expect(
			await harness.database
				.prepare('SELECT COALESCE(disabled, 0) AS disabled FROM oauthClient WHERE clientId = ?')
				.bind(credential.clientId)
				.first(),
		).toEqual({ disabled: 0 });
	} finally {
		await harness.close();
	}
});

it('agent: a named management request ID cannot change operation, client, organization or workspace intent', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const binding = await harness.miniflare.getBindings<{
			readonly SIGN_IN: ReturnType<typeof createSignInManagementBinding>;
		}>('gateway-one');
		const original = {
			token: owner,
			organizationId: organizationOne,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		};
		const registration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registration.status).toBe(200);
		const first = agentCredentialSchema
			.extend({
				kind: z.literal('registered'),
				workspaceId: z.literal(workspaceOne),
				resource: z.literal(workspaceAudience(workspaceOne)),
			})
			.strict()
			.parse(await registration.json());
		async function protectedState(): Promise<unknown> {
			return Promise.all(
				[
					'SELECT * FROM oauthClient ORDER BY clientId',
					'SELECT * FROM oauthResource ORDER BY identifier',
					'SELECT * FROM oauthClientResource ORDER BY clientId, resourceId',
					'SELECT * FROM sign_in_audit ORDER BY id',
				].map(
					async (sql: string): Promise<unknown> =>
						(await harness.database.prepare(sql).all()).results,
				),
			);
		}
		const before = await protectedState();
		const conflicts = await Promise.all([
			binding.SIGN_IN.registerAndLink({ ...original, workspaceId: workspaceTwo }),
			binding.SIGN_IN.registerAndLink({ ...original, organizationId: organizationTwo }),
			binding.SIGN_IN.link({ ...original, clientId: first.clientId }),
			binding.SIGN_IN.unlink({ ...original, clientId: 'other-client' }),
			binding.SIGN_IN.disable({
				token: owner,
				organizationId: organizationOne,
				clientId: first.clientId,
				requestId: registrationRequestId,
			}),
		]);
		for (const result of conflicts) {
			expect(result).toEqual({ kind: 'refused', reason: 'operation-conflict' });
			expectNoIssuedCredentials(result);
		}
		expect(await protectedState()).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('agent: an incompatible workspace resource is never overwritten or linked by management', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const one = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(one.status).toBe(200);
		const credential = agentCredentialSchema.parse(await one.json());
		const resourceOwner = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceTwo,
			requestId: crypto.randomUUID(),
		});
		expect(resourceOwner.status).toBe(200);
		const foreignMetadata = JSON.stringify({
			kind: 'workspace',
			organizationId: organizationTwo,
			workspaceId: workspaceTwo,
		});
		await harness.database
			.prepare('UPDATE oauthResource SET metadata = ? WHERE identifier = ?')
			.bind(foreignMetadata, workspaceAudience(workspaceTwo))
			.run();
		const beforeResource = await harness.database
			.prepare('SELECT * FROM oauthResource WHERE identifier = ?')
			.bind(workspaceAudience(workspaceTwo))
			.first();
		const beforeLinks = (
			await harness.database
				.prepare('SELECT * FROM oauthClientResource ORDER BY clientId, resourceId')
				.all()
		).results;
		const bindings = await harness.miniflare.getBindings<{
			readonly SIGN_IN: ReturnType<typeof createSignInManagementBinding>;
		}>('gateway-one');
		const refused = await bindings.SIGN_IN.link({
			token: owner,
			organizationId: organizationOne,
			workspaceId: workspaceTwo,
			clientId: credential.clientId,
			requestId: crypto.randomUUID(),
		});
		expect(refused).toEqual({ kind: 'refused', reason: 'resource-conflict' });
		expectNoIssuedCredentials(refused);
		expect(
			await harness.database
				.prepare('SELECT * FROM oauthResource WHERE identifier = ?')
				.bind(workspaceAudience(workspaceTwo))
				.first(),
		).toEqual(beforeResource);
		expect(
			(
				await harness.database
					.prepare('SELECT * FROM oauthClientResource ORDER BY clientId, resourceId')
					.all()
			).results,
		).toEqual(beforeLinks);
	} finally {
		await harness.close();
	}
});
