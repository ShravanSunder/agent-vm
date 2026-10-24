import { expect, it } from 'vitest';

import {
	startLocalAuthHarness,
	workspaceOne,
	workspaceAudience,
	registrationRequestId,
	registeredClientId,
} from '#auth/test-fixtures/local-auth-harness';
import {
	addWorkspaceAgent,
	agentCredentialSchema,
	workspaceToken,
} from '#auth/test-fixtures/workspace-agent-proof';

it.each([
	{ entity: 'resource-changed', phase: 'intent', resources: 0, clients: 0, links: 0 },
	{ entity: 'resource-changed', phase: 'outcome', resources: 1, clients: 0, links: 0 },
	{ entity: 'client-link-changed', phase: 'intent', resources: 1, clients: 1, links: 0 },
	{ entity: 'client-link-changed', phase: 'outcome', resources: 1, clients: 1, links: 1 },
])(
	'agent: an actual $entity $phase audit failure withholds workspace credentials until the same-operation retry',
	async (fault) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			await harness.database.exec(
				`CREATE TRIGGER fail_workspace_audit BEFORE INSERT ON sign_in_audit WHEN NEW.request_id = '${registrationRequestId}' AND NEW.kind = '${fault.entity}' AND NEW.phase = '${fault.phase}' BEGIN SELECT RAISE(FAIL, 'controlled-workspace-audit-fault'); END;`,
			);
			const failed = await addWorkspaceAgent({
				harness,
				owner,
				workspaceId: workspaceOne,
				requestId: registrationRequestId,
			});
			expect(failed.status).toBe(503);
			// An incomplete result identifies the retry but never includes a credential.
			expect(await failed.json()).toEqual({ kind: 'incomplete', clientId: registeredClientId });
			expect(
				(
					await harness.database
						.prepare('SELECT identifier FROM oauthResource WHERE identifier = ?')
						.bind(workspaceAudience(workspaceOne))
						.all()
				).results,
			).toHaveLength(fault.resources);
			expect(
				(
					await harness.database
						.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?')
						.bind(registeredClientId)
						.all()
				).results,
			).toHaveLength(fault.clients);
			expect(
				(
					await harness.database
						.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
						.bind(registeredClientId)
						.all()
				).results,
			).toHaveLength(fault.links);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
					)
				).json(),
			).not.toHaveProperty(`member:${registeredClientId}`);
			const failedRecord = await harness.database
				.prepare('SELECT id FROM sign_in_audit WHERE request_id = ? AND kind = ? AND phase = ?')
				.bind(registrationRequestId, fault.entity, fault.phase)
				.all();
			expect(failedRecord.results).toEqual([]);
			await harness.database.exec('DROP TRIGGER fail_workspace_audit');
			const retried = await addWorkspaceAgent({
				harness,
				owner,
				workspaceId: workspaceOne,
				requestId: registrationRequestId,
			});
			expect(retried.status).toBe(200);
			const credential = agentCredentialSchema.parse(await retried.json());
			expect(credential.clientId).toBe(registeredClientId);
			expect(
				(
					await harness.database
						.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?')
						.bind(registeredClientId)
						.all()
				).results,
			).toEqual([{ clientId: registeredClientId }]);
			await Promise.all(
				['resource-changed', 'client-link-changed', 'client-changed', 'client-management'].map(
					async (entity): Promise<void> => {
						const rows = (
							await harness.database
								.prepare(
									'SELECT DISTINCT phase FROM sign_in_audit WHERE request_id = ? AND kind = ? ORDER BY phase',
								)
								.bind(registrationRequestId, entity)
								.all()
						).results;
						expect(rows).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
					},
				),
			);
			expect(await workspaceToken({ harness, credential, workspaceId: workspaceOne })).toBeTypeOf(
				'string',
			);
		} finally {
			await harness.close();
		}
	},
	120_000,
);
