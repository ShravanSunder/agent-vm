import { expect, it } from 'vitest';

import type { AgentClientManagementPort } from '#tool-host-core/agent-management/agent-client-management-port';
import { createWorkspaceAgentManagement } from '#tool-host-core/agent-management/workspace-agent-management';
import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

const organizationId = '11111111-1111-4111-8111-111111111111';
const workspaceOne = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceTwo = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rejectedId = 'b015079b-19b6-4aa2-9b82-1298efcb2f79';
const recoveryId = 'b015079b-19b6-4aa2-9b82-1298efcb2f80';
const clientId = 'agent-one';
const portalOrigin = 'https://portal.invalid';

function removalFixture(): {
	readonly authority: (workspaceId: string) => ReturnType<typeof createWorkspaceAuthority>;
	readonly request: (operation: 'unlink' | 'disable', requestId?: string) => Promise<Response>;
	readonly issuer: {
		enabled: boolean;
		readonly links: Set<string>;
		readonly unlinkRequests: string[];
		readonly disableRequests: string[];
		readonly outcomes: Map<string, 'refused' | 'incomplete' | 'complete'>;
	};
	readonly controls: { failSwapOnce: boolean };
	readonly add: () => Promise<Response>;
} {
	const authorities = new Map<string, ReturnType<typeof createWorkspaceAuthority>>();
	const issuer = {
		enabled: true,
		links: new Set([workspaceOne, workspaceTwo]),
		unlinkRequests: new Array<string>(),
		disableRequests: new Array<string>(),
		outcomes: new Map<string, 'refused' | 'incomplete' | 'complete'>([[rejectedId, 'refused']]),
	};
	const controls = { failSwapOnce: false };
	function authority(workspaceId: string): ReturnType<typeof createWorkspaceAuthority> {
		let current = authorities.get(workspaceId);
		if (current === undefined) {
			current = createWorkspaceAuthority({
				store: createVolatileAuthorityStore(),
				clock: { nowMs: () => 100 },
				cap: 1024,
			});
			authorities.set(workspaceId, current);
		}
		return current;
	}
	const signIn: AgentClientManagementPort = {
		humanCheckStatus: async () => ({ kind: 'ready', level: 'remembered-login' }),
		isLiveOwner: async () => true,
		ownsAgentClient: async (input) => input.clientId === clientId,
		registerAndLink: async () => {
			throw new Error('Registration is outside this fixture');
		},
		link: async () => {
			throw new Error('Link is outside this fixture');
		},
		unlink: async (input) => {
			expect(await authority(input.workspaceId).readMembership(clientId)).toBeNull();
			issuer.unlinkRequests.push(input.requestId);
			if (issuer.outcomes.get(input.requestId) === 'refused')
				return { kind: 'refused', reason: 'operation-conflict' };
			if (issuer.outcomes.get(input.requestId) === 'incomplete')
				return { kind: 'incomplete', clientId };
			issuer.links.delete(input.workspaceId);
			return {
				kind: 'unlinked',
				clientId,
				workspaceId: input.workspaceId,
				resource: `${portalOrigin}/workspaces/${input.workspaceId}/mcp`,
			};
		},
		disable: async (input) => {
			await Promise.all(
				[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
					expect(await authority(workspaceId).readMembership(clientId)).toBeNull();
				}),
			);
			issuer.disableRequests.push(input.requestId);
			if (issuer.outcomes.get(input.requestId) === 'refused')
				return { kind: 'refused', reason: 'operation-conflict' };
			if (issuer.outcomes.get(input.requestId) === 'incomplete')
				return { kind: 'incomplete', clientId };
			issuer.enabled = false;
			return { kind: 'disabled', clientId };
		},
	};
	const management = createWorkspaceAgentManagement({
		verifier: {
			verify: async () => ({
				kind: 'verified',
				freshness: { kind: 'signature' },
				proof: {
					issuer: 'https://issuer.invalid',
					subject: 'owner-one',
					audience: `${portalOrigin}/management`,
					sessionRef: 'session-one',
					clientId: 'owner-cli',
					expiresAt: 400,
				},
			}),
		},
		signIn,
		toolPortalOrigin: portalOrigin,
		configurations: {
			workspaceIdsForOrganization: async () => [workspaceOne, workspaceTwo],
			read: async () =>
				workspaceConfigurationSchema.parse({
					organizationId,
					workspaceName: 'fixture',
					approvalKeyBinding: 'KEY',
					mcp: { schemaVersion: 1, providers: {} },
					portal: { schemaVersion: 1, profiles: { reader: { namespaces: {} } } },
				}),
		},
		workspaces: {
			forWorkspace: (workspaceId) => ({
				...authority(workspaceId),
				beginAgentRemoval: async (selectedClient, operationId, intent) => {
					if (
						controls.failSwapOnce &&
						workspaceId === workspaceTwo &&
						intent.replacesPendingRequestId !== undefined
					) {
						controls.failSwapOnce = false;
						throw new Error('Controlled W2 replacement write failure');
					}
					return authority(workspaceId).beginAgentRemoval(selectedClient, operationId, intent);
				},
			}),
		},
	});
	return {
		authority,
		issuer,
		controls,
		add: async () =>
			management.handle(
				new Request(`${portalOrigin}/management/workspaces/${workspaceOne}/agents`, {
					method: 'POST',
					headers: { authorization: 'Bearer owner-proof', 'content-type': 'application/json' },
					body: JSON.stringify({ requestId: recoveryId, clientId, persona: 'reader' }),
				}),
			),
		request: async (operation, requestId) =>
			management.handle(
				new Request(
					`${portalOrigin}/management/${operation === 'unlink' ? `workspaces/${workspaceOne}` : `organizations/${organizationId}`}/agents/${clientId}`,
					{
						method: requestId === undefined ? 'GET' : 'DELETE',
						headers: { authorization: 'Bearer owner-proof', 'content-type': 'application/json' },
						...(requestId === undefined ? {} : { body: JSON.stringify({ requestId }) }),
					},
				),
			),
	};
}

// Signature and issuer behavior are contract doubles; coordinator and membership transactions are real.
it.each(['unlink', 'disable'] as const)(
	'returns typed %s conflict without trapping a fresh authorized removal',
	async (operation) => {
		const target = removalFixture();
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				await target.authority(workspaceId).setMembership(clientId, 'reader');
			}),
		);
		const response = await target.request(operation, rejectedId);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		const touched = operation === 'unlink' ? [workspaceOne] : [workspaceOne, workspaceTwo];
		await Promise.all(
			touched.map(async (workspaceId): Promise<void> => {
				expect(await target.authority(workspaceId).readMembership(clientId)).toBeNull();
				expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
					kind: 'pending',
					operation,
					requestId: rejectedId,
				});
			}),
		);
		expect(target.issuer.enabled).toBe(true);
		expect([...target.issuer.links]).toEqual([workspaceOne, workspaceTwo]);
		const status = await target.request(operation);
		expect(status.status).toBe(403);
		expect(await status.json()).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		await Promise.all(
			touched.map(async (workspaceId): Promise<void> => {
				expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
					kind: 'pending',
					operation,
					requestId: rejectedId,
				});
			}),
		);
		const addition = await target.add();
		expect(addition.status).toBe(403);
		expect(await addition.json()).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		const recovered = await target.request(operation, recoveryId);
		expect(recovered.status).toBe(200);
		expect(await recovered.json()).toEqual({
			kind: 'removed',
			clientId,
			...(operation === 'unlink' ? { workspaceId: workspaceOne } : {}),
		});
		await Promise.all(
			touched.map(async (workspaceId): Promise<void> => {
				expect(await target.authority(workspaceId).readMembership(clientId)).toBeNull();
				expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
					kind: 'complete',
					operation,
					requestId: recoveryId,
				});
			}),
		);
		expect(
			operation === 'unlink' ? target.issuer.unlinkRequests : target.issuer.disableRequests,
		).toEqual([rejectedId, rejectedId, rejectedId, rejectedId, recoveryId]);
		expect((await target.request(operation, rejectedId)).status).toBe(200);
		await Promise.all(
			touched.map(async (workspaceId): Promise<void> => {
				expect((await target.authority(workspaceId).readAgentRemoval(clientId))?.requestId).toBe(
					recoveryId,
				);
			}),
		);
		expect(target.issuer.enabled).toBe(operation === 'unlink');
		expect([...target.issuer.links]).toEqual(
			operation === 'unlink' ? [workspaceTwo] : [workspaceOne, workspaceTwo],
		);
	},
);

it.each(['unlink', 'disable'] as const)(
	're-observes an old %s outcome before replacing its request ID',
	async (operation) => {
		await Promise.all(
			(['complete', 'incomplete'] as const).map(async (outcome): Promise<void> => {
				const target = removalFixture();
				await Promise.all(
					[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
						await target.authority(workspaceId).setMembership(clientId, 'reader');
					}),
				);
				expect((await target.request(operation, rejectedId)).status).toBe(403);
				target.issuer.outcomes.set(rejectedId, outcome);
				const response = await target.request(operation, recoveryId);
				expect(response.status).toBe(outcome === 'complete' ? 200 : 202);
				const touched = operation === 'unlink' ? [workspaceOne] : [workspaceOne, workspaceTwo];
				await Promise.all(
					touched.map(async (workspaceId): Promise<void> => {
						expect(await target.authority(workspaceId).readMembership(clientId)).toBeNull();
						expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
							kind: outcome === 'complete' ? 'complete' : 'pending',
							operation,
							requestId: rejectedId,
						});
					}),
				);
				expect(
					operation === 'unlink' ? target.issuer.unlinkRequests : target.issuer.disableRequests,
				).toEqual([rejectedId, rejectedId]);
			}),
		);
	},
);

const otherPendingId = 'b015079b-19b6-4aa2-9b82-1298efcb2f81';
async function seedMixedRetirement(target: ReturnType<typeof removalFixture>): Promise<void> {
	await Promise.all(
		[
			[workspaceOne, rejectedId],
			[workspaceTwo, otherPendingId],
		].map(async ([workspaceId, requestId]): Promise<void> => {
			if (workspaceId === undefined || requestId === undefined)
				throw new Error('Fixture identity missing');
			await target.authority(workspaceId).setMembership(clientId, 'reader');
			await target
				.authority(workspaceId)
				.beginAgentRemoval(clientId, requestId, { operation: 'disable' });
		}),
	);
}

it('converges a retirement retry after the second guarded ID replacement fails', async () => {
	const target = removalFixture();
	await Promise.all(
		[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
			await target.authority(workspaceId).setMembership(clientId, 'reader');
		}),
	);
	expect((await target.request('disable', rejectedId)).status).toBe(403);
	target.controls.failSwapOnce = true;
	expect((await target.request('disable', recoveryId)).status).toBe(503);
	expect(target.issuer.disableRequests).toEqual([rejectedId, rejectedId]);
	await Promise.all(
		[
			[workspaceOne, recoveryId],
			[workspaceTwo, rejectedId],
		].map(async ([workspaceId, requestId]): Promise<void> => {
			if (workspaceId === undefined || requestId === undefined)
				throw new Error('Fixture identity missing');
			expect(await target.authority(workspaceId).readMembership(clientId)).toBeNull();
			expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
				kind: 'pending',
				operation: 'disable',
				requestId,
			});
		}),
	);
	expect(target.issuer.enabled).toBe(true);
	expect((await target.request('disable', recoveryId)).status).toBe(200);
	expect(target.issuer.disableRequests).toEqual([rejectedId, rejectedId, rejectedId, recoveryId]);
	await Promise.all(
		[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
			expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
				kind: 'complete',
				operation: 'disable',
				requestId: recoveryId,
			});
		}),
	);
	expect(target.issuer.enabled).toBe(false);
});

it.each(['refused', 'incomplete'] as const)(
	'lets an already disabled old ID win over another %s ID without using the fresh ID',
	async (otherOutcome) => {
		const target = removalFixture();
		await seedMixedRetirement(target);
		target.issuer.outcomes.set(rejectedId, 'complete');
		target.issuer.outcomes.set(otherPendingId, otherOutcome);
		expect((await target.request('disable', recoveryId)).status).toBe(200);
		expect(target.issuer.disableRequests).toEqual([rejectedId, otherPendingId]);
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
					kind: 'complete',
					operation: 'disable',
					requestId: rejectedId,
				});
			}),
		);
		expect(target.issuer.enabled).toBe(false);
	},
);

it('keeps every mixed retirement ID when a prior operation is still incomplete', async () => {
	const target = removalFixture();
	await seedMixedRetirement(target);
	target.issuer.outcomes.set(otherPendingId, 'incomplete');
	expect((await target.request('disable', recoveryId)).status).toBe(202);
	expect(target.issuer.disableRequests).toEqual([rejectedId, otherPendingId]);
	expect((await target.authority(workspaceOne).readAgentRemoval(clientId))?.requestId).toBe(
		rejectedId,
	);
	expect((await target.authority(workspaceTwo).readAgentRemoval(clientId))?.requestId).toBe(
		otherPendingId,
	);
	expect(target.issuer.enabled).toBe(true);
});

it('aggregates mixed GET outcomes without swapping or inventing an ID', async () => {
	const target = removalFixture();
	await seedMixedRetirement(target);
	target.issuer.outcomes.set(otherPendingId, 'incomplete');
	const refused = await target.request('disable');
	expect(refused.status).toBe(403);
	expect(await refused.json()).toEqual({ kind: 'refused', reason: 'operation-conflict' });
	target.issuer.outcomes.set(rejectedId, 'complete');
	expect((await target.request('disable')).status).toBe(202);
	expect(await target.authority(workspaceOne).readAgentRemoval(clientId)).toEqual({
		kind: 'complete',
		operation: 'disable',
		requestId: rejectedId,
	});
	expect(await target.authority(workspaceTwo).readAgentRemoval(clientId)).toEqual({
		kind: 'pending',
		operation: 'disable',
		requestId: otherPendingId,
	});
	target.issuer.outcomes.set(otherPendingId, 'complete');
	expect((await target.request('disable')).status).toBe(200);
	expect(target.issuer.disableRequests).not.toContain(recoveryId);
	expect((await target.authority(workspaceOne).readAgentRemoval(clientId))?.requestId).toBe(
		rejectedId,
	);
	expect((await target.authority(workspaceTwo).readAgentRemoval(clientId))?.requestId).toBe(
		otherPendingId,
	);
});
