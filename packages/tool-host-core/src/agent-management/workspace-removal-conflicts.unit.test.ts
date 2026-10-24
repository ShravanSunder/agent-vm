import { expect, it } from 'vitest';

import {
	clientId,
	rejectedId,
	recoveryId,
	workspaceOne,
	workspaceTwo,
	removalFixture,
} from '#tool-host-core/agent-management/test-fixtures/workspace-removal-fixture';

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

async function completedUnlinkHistory(
	unlinkWorkspaceId: string,
): Promise<ReturnType<typeof removalFixture>> {
	const target = removalFixture(unlinkWorkspaceId);
	await Promise.all(
		[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
			await target.authority(workspaceId).setMembership(clientId, 'reader');
		}),
	);
	target.issuer.outcomes.delete(rejectedId);
	expect((await target.request('unlink', rejectedId)).status).toBe(200);
	return target;
}

async function workspaceRemovalState(target: ReturnType<typeof removalFixture>): Promise<unknown> {
	return Promise.all(
		[workspaceOne, workspaceTwo].map(async (workspaceId) => ({
			workspaceId,
			membership: await target.authority(workspaceId).readMembership(clientId),
			removal: await target.authority(workspaceId).readAgentRemoval(clientId),
		})),
	);
}

it.each([workspaceOne, workspaceTwo])(
	'refuses retirement ID reuse from completed unlink in %s before writing any workspace',
	async (unlinkWorkspaceId) => {
		const target = await completedUnlinkHistory(unlinkWorkspaceId);
		const before = await workspaceRemovalState(target);
		target.controls.beginRequests.length = 0;
		const refused = await target.request('disable', rejectedId);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		expect(await workspaceRemovalState(target)).toEqual(before);
		expect(target.controls.beginRequests).toEqual([]);
		expect(target.issuer.disableRequests).toEqual([]);
		expect(target.issuer.enabled).toBe(true);
		expect([...target.issuer.links]).toEqual([
			unlinkWorkspaceId === workspaceOne ? workspaceTwo : workspaceOne,
		]);
	},
);

it.each([workspaceOne, workspaceTwo])(
	'GET reports a locally refused pending retirement ID beside completed unlink in %s without writes',
	async (unlinkWorkspaceId) => {
		const target = await completedUnlinkHistory(unlinkWorkspaceId);
		const pendingWorkspace = unlinkWorkspaceId === workspaceOne ? workspaceTwo : workspaceOne;
		await target
			.authority(pendingWorkspace)
			.beginAgentRemoval(clientId, rejectedId, { operation: 'disable' });
		const before = await workspaceRemovalState(target);
		target.controls.beginRequests.length = 0;
		const refused = await target.request('disable');
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		expect(await workspaceRemovalState(target)).toEqual(before);
		expect(target.controls.beginRequests).toEqual([]);
		expect(target.issuer.disableRequests).toEqual([]);
		expect(target.issuer.enabled).toBe(true);
	},
);

it.each([workspaceOne, workspaceTwo])(
	'a fresh retirement ID recovers the forced local-conflict leftover beside completed unlink in %s',
	async (unlinkWorkspaceId) => {
		const target = await completedUnlinkHistory(unlinkWorkspaceId);
		const pendingWorkspace = unlinkWorkspaceId === workspaceOne ? workspaceTwo : workspaceOne;
		await target
			.authority(pendingWorkspace)
			.beginAgentRemoval(clientId, rejectedId, { operation: 'disable' });
		const recovered = await target.request('disable', recoveryId);
		expect(recovered.status).toBe(200);
		expect(await recovered.json()).toEqual({ kind: 'removed', clientId });
		expect(await target.authority(unlinkWorkspaceId).readAgentRemoval(clientId)).toEqual({
			kind: 'complete',
			operation: 'disable',
			requestId: recoveryId,
		});
		expect(await target.authority(pendingWorkspace).readAgentRemoval(clientId)).toEqual({
			kind: 'complete',
			operation: 'disable',
			requestId: recoveryId,
		});
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				expect(await target.authority(workspaceId).readMembership(clientId)).toBeNull();
			}),
		);
		expect(target.issuer.disableRequests).toEqual([recoveryId]);
		expect(target.issuer.enabled).toBe(false);
	},
);

it('completed unlink history is not a disabled winner over an incomplete retirement', async () => {
	const target = await completedUnlinkHistory(workspaceOne);
	await target
		.authority(workspaceTwo)
		.beginAgentRemoval(clientId, recoveryId, { operation: 'disable' });
	target.issuer.outcomes.set(recoveryId, 'incomplete');
	expect((await target.request('disable', otherPendingId)).status).toBe(202);
	await Promise.all(
		[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
			expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
				kind: 'pending',
				operation: 'disable',
				requestId: recoveryId,
			});
		}),
	);
	expect(target.issuer.disableRequests).toEqual([recoveryId]);
	expect(target.issuer.enabled).toBe(true);
});

it('retirement after all workspaces completed unlink records its incomplete ID for a later GET', async () => {
	const target = await completedUnlinkHistory(workspaceOne);
	expect((await target.request('unlink', otherPendingId, workspaceTwo)).status).toBe(200);
	target.issuer.outcomes.set(recoveryId, 'incomplete');
	expect((await target.request('disable', recoveryId)).status).toBe(202);
	await Promise.all(
		[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
			expect(await target.authority(workspaceId).readMembership(clientId)).toBeNull();
			expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
				kind: 'pending',
				operation: 'disable',
				requestId: recoveryId,
			});
		}),
	);
	expect((await target.request('disable')).status).toBe(202);
	expect(target.issuer.enabled).toBe(true);
	target.issuer.outcomes.set(recoveryId, 'complete');
	expect((await target.request('disable')).status).toBe(200);
	await Promise.all(
		[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
			expect(await target.authority(workspaceId).readAgentRemoval(clientId)).toEqual({
				kind: 'complete',
				operation: 'disable',
				requestId: recoveryId,
			});
		}),
	);
	expect(target.issuer.disableRequests).toEqual([recoveryId, recoveryId, recoveryId]);
	expect(target.issuer.enabled).toBe(false);
	expect((await target.request('unlink', rejectedId)).status).toBe(200);
	expect(target.issuer.disableRequests).toEqual([recoveryId, recoveryId, recoveryId]);
});

it.each(['local conflict', 'storage failure'] as const)(
	're-reads a rejected retirement begin and distinguishes %s before recovery',
	async (failure) => {
		const target = removalFixture();
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				await target.authority(workspaceId).setMembership(clientId, 'reader');
			}),
		);
		target.controls.raceUnlinkOnce = failure === 'local conflict';
		target.controls.failBeginOnce = failure === 'storage failure';
		const refused = await target.request('disable', rejectedId);
		expect(refused.status).toBe(failure === 'local conflict' ? 403 : 503);
		expect(await refused.json()).toEqual(
			failure === 'local conflict'
				? { kind: 'refused', reason: 'operation-conflict' }
				: { error: 'management-unavailable' },
		);
		expect(target.issuer.disableRequests).toEqual([]);
		expect((await target.request('disable', recoveryId)).status).toBe(200);
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
	},
);
