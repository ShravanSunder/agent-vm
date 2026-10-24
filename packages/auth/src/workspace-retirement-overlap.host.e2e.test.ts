import { expect, it } from 'vitest';

import {
	startLocalAuthHarness,
	workspaceOne,
	workspaceTwo,
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

it.each(['retirement supersedes pending unlink', 'stale unlink retry reads retirement'] as const)(
	'agent: $0 without unlinking or repeating global disable',
	async (scenario) => {
		const harness = await startLocalAuthHarness();
		const retirementRequestId = crypto.randomUUID();
		let retirement: Promise<Response> | undefined;
		let holdArmed = false;
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
			expect(
				(
					await addWorkspaceAgent({
						harness,
						owner,
						workspaceId: workspaceTwo,
						requestId: crypto.randomUUID(),
						clientId: credential.clientId,
					})
				).status,
			).toBe(200);
			const old = await workspaceToken({ harness, credential, workspaceId: workspaceOne });
			await harness.database.exec(
				`CREATE TRIGGER hold_unlink BEFORE DELETE ON oauthClientResource WHEN OLD.clientId = '${registeredClientId}' BEGIN SELECT RAISE(FAIL, 'pending-unlink-for-retirement'); END;`,
			);
			// This table is test-only observation of real provider writes, never a production owner.
			await harness.database.exec('CREATE TABLE proof_disable_updates (client_id TEXT NOT NULL)');
			await harness.database.exec(
				`CREATE TRIGGER observe_disable AFTER UPDATE OF disabled ON oauthClient WHEN NEW.clientId = '${registeredClientId}' AND NEW.disabled = 1 BEGIN INSERT INTO proof_disable_updates(client_id) VALUES (NEW.clientId); END;`,
			);
			const unlinkRequestId = crypto.randomUUID();
			const removalPath = `/management/workspaces/${workspaceOne}/agents/${credential.clientId}`;
			const unlink = {
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: unlinkRequestId }),
			};
			expect((await harness.gateway(removalPath, unlink)).status).toBe(202);
			async function workspaceState(workspaceId: string): Promise<unknown> {
				return (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
					)
				).json();
			}
			expect(await workspaceState(workspaceOne)).toEqual({
				[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
				[`member-removal:${credential.clientId}`]: {
					kind: 'pending',
					operation: 'unlink',
					requestId: unlinkRequestId,
				},
			});
			const unlinkAuditBefore = (
				await harness.database
					.prepare(
						"SELECT * FROM sign_in_audit WHERE kind = 'client-link-changed' AND change_kind = 'unlinked' ORDER BY id",
					)
					.all()
			).results;
			holdArmed = true;
			expect(await harness.managementHolds.armManagementHold(retirementRequestId)).toEqual({
				armed: true,
			});
			retirement = harness.gateway(
				`/management/organizations/${organizationOne}/agents/${credential.clientId}`,
				{
					method: 'DELETE',
					headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
					body: JSON.stringify({ requestId: retirementRequestId }),
				},
			);
			void retirement.catch(() => undefined);
			expect(await harness.managementHolds.enteredManagementHold(retirementRequestId)).toEqual({
				point: 'before-provider-owner-read',
				requestId: retirementRequestId,
			});
			for (const state of await Promise.all([
				workspaceState(workspaceOne),
				workspaceState(workspaceTwo),
			])) {
				expect(state).toEqual({
					[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
					[`member-removal:${credential.clientId}`]: {
						kind: 'pending',
						operation: 'disable',
						requestId: retirementRequestId,
					},
				});
			}
			const effectsBefore = [...harness.effects];
			expect(
				(
					await callWorkspaceTool({
						harness,
						workspaceId: workspaceOne,
						token: old,
						correlation: 'retirement-pending',
					})
				).status,
			).toBe(401);
			expect(harness.effects).toEqual(effectsBefore);
			expect(
				(await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })).status,
			).toBe(200);
			await harness.managementHolds.releaseManagementHold(retirementRequestId);
			holdArmed = false;
			const result = await retirement;
			expect(result.status).toBe(200);
			expect(await result.json()).toEqual({ kind: 'removed', clientId: credential.clientId });
			const completedStates = await Promise.all([
				workspaceState(workspaceOne),
				workspaceState(workspaceTwo),
			]);
			for (const state of completedStates)
				expect(state).toEqual({
					[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
					[`member-removal:${credential.clientId}`]: {
						kind: 'complete',
						operation: 'disable',
						requestId: retirementRequestId,
					},
				});
			if (scenario === 'stale unlink retry reads retirement') {
				const stale = await harness.gateway(removalPath, unlink);
				expect(stale.status).toBe(200);
				expect(await stale.json()).toEqual({
					kind: 'removed',
					clientId: credential.clientId,
				});
				expect(
					await Promise.all([workspaceState(workspaceOne), workspaceState(workspaceTwo)]),
				).toEqual(completedStates);
			}
			expect(
				(await harness.database.prepare('SELECT client_id FROM proof_disable_updates').all())
					.results,
			).toEqual([{ client_id: credential.clientId }]);
			expect(
				(
					await harness.database
						.prepare(
							"SELECT * FROM sign_in_audit WHERE kind = 'client-link-changed' AND change_kind = 'unlinked' ORDER BY id",
						)
						.all()
				).results,
			).toEqual(unlinkAuditBefore);
			expect(
				(
					await harness.database
						.prepare(
							'SELECT resourceId FROM oauthClientResource WHERE clientId = ? ORDER BY resourceId',
						)
						.bind(credential.clientId)
						.all()
				).results,
			).toEqual(
				[workspaceOne, workspaceTwo].map((workspaceId) => ({
					resourceId: workspaceAudience(workspaceId),
				})),
			);
			expect(
				await harness.database
					.prepare('SELECT COALESCE(disabled, 0) AS disabled FROM oauthClient WHERE clientId = ?')
					.bind(credential.clientId)
					.first(),
			).toEqual({ disabled: 1 });
			expect(
				await (
					await workspaceTokenResponse({ harness, credential, workspaceId: workspaceTwo })
				).json(),
			).toMatchObject({ error: 'invalid_client' });
		} finally {
			if (holdArmed) await harness.managementHolds.releaseManagementHold(retirementRequestId);
			await retirement?.catch(() => undefined);
			await harness.close();
		}
	},
	120_000,
);
