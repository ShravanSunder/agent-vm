import { describe, expect, it } from 'vitest';

import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

const requestId = 'b015079b-19b6-4aa2-9b82-1298efcb2f79';
describe('workspace removal authority', () => {
	it('refuses stale admission after removal began, including after retirement completes', async () => {
		const authority = createWorkspaceAuthority({
			store: createVolatileAuthorityStore(),
			clock: { nowMs: () => 100 },
			cap: 1024,
		});
		await authority.setMembership('agent-one', 'reader');
		await authority.beginAgentRemoval('agent-one', requestId, { operation: 'disable' });
		await expect(authority.setMembership('agent-one', 'reader')).rejects.toThrow();
		expect(await authority.readMembership('agent-one')).toBeNull();
		await authority.completeAgentRemoval('agent-one', requestId, 'disable');
		await expect(authority.setMembership('agent-one', 'reader')).rejects.toThrow();
	});
	it('ignores legacy agent rows and removes absent members without fabricating a persona', async () => {
		const store = createVolatileAuthorityStore();
		await store.write('agent:agent-one', { state: 'listed' });
		const authority = createWorkspaceAuthority({ store, clock: { nowMs: () => 100 }, cap: 1024 });
		expect(await authority.readMembership('agent-one')).toBeNull();
		await authority.beginAgentRemoval('agent-one', requestId, { operation: 'unlink' });
		expect(await store.read('member:agent-one')).toBeUndefined();
		expect(await authority.readAgentRemoval('agent-one')).toEqual({
			kind: 'pending',
			operation: 'unlink',
			requestId,
		});
	});
	it('atomically replaces only the exact pending intent and never reopens completion', async () => {
		const authority = createWorkspaceAuthority({
			store: createVolatileAuthorityStore(),
			clock: { nowMs: () => 100 },
			cap: 1024,
		});
		const replacementId = 'b015079b-19b6-4aa2-9b82-1298efcb2f80';
		await authority.setMembership('agent-one', 'reader');
		await authority.beginAgentRemoval('agent-one', requestId, { operation: 'disable' });
		await expect(
			authority.beginAgentRemoval('agent-one', replacementId, {
				operation: 'unlink',
				replacesPendingRequestId: requestId,
			}),
		).rejects.toThrow('replacement conflicts');
		await authority.beginAgentRemoval('agent-one', replacementId, {
			operation: 'disable',
			replacesPendingRequestId: requestId,
		});
		await expect(
			authority.beginAgentRemoval('agent-one', requestId, {
				operation: 'disable',
				replacesPendingRequestId: requestId,
			}),
		).rejects.toThrow('replacement conflicts');
		expect(await authority.readMembership('agent-one')).toBeNull();
		expect(await authority.readAgentRemoval('agent-one')).toEqual({
			kind: 'pending',
			operation: 'disable',
			requestId: replacementId,
		});
		await authority.completeAgentRemoval('agent-one', replacementId, 'disable');
		await expect(
			authority.beginAgentRemoval('agent-one', requestId, {
				operation: 'disable',
				replacesPendingRequestId: replacementId,
			}),
		).rejects.toThrow('replacement conflicts');
		expect(await authority.readAgentRemoval('agent-one')).toEqual({
			kind: 'complete',
			operation: 'disable',
			requestId: replacementId,
		});
	});
	it('admits only one concurrent replacement of the same observed pending ID', async () => {
		const authority = createWorkspaceAuthority({
			store: createVolatileAuthorityStore(),
			clock: { nowMs: () => 100 },
			cap: 1024,
		});
		await authority.beginAgentRemoval('agent-one', requestId, { operation: 'disable' });
		const outcomes = await Promise.allSettled(
			['b015079b-19b6-4aa2-9b82-1298efcb2f80', 'b015079b-19b6-4aa2-9b82-1298efcb2f81'].map(
				(nextId) =>
					authority.beginAgentRemoval('agent-one', nextId, {
						operation: 'disable',
						replacesPendingRequestId: requestId,
					}),
			),
		);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
		const winner = outcomes.find((outcome) => outcome.status === 'fulfilled');
		if (winner?.status !== 'fulfilled') throw new Error('Replacement winner missing');
		expect(await authority.readAgentRemoval('agent-one')).toEqual(winner.value);
		expect(await authority.readMembership('agent-one')).toBeNull();
	});
});
