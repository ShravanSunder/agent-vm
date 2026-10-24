import { describe, expect, it } from 'vitest';

import type { WorkspaceAuthorityStore } from '#tool-host-core/workspace-authority/models/workspace-authority-store';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

const clock = { nowMs: () => 100 };

describe('organization authority over an atomic volatile store in plain Node', () => {
	it('commits first use and admission through the same exported authority used by the adapter', async () => {
		const store = createVolatileAuthorityStore();
		const authority = createWorkspaceAuthority({ store, clock, cap: 1024 });
		expect((await authority.readMembership('sender')) !== null).toBe(false);
		await authority.setMembership('sender', 'fixture');
		expect(await store.read('member:sender')).toEqual({ state: 'member', persona: 'fixture' });
		expect((await authority.readMembership('sender')) !== null).toBe(true);
		expect(await authority.consumeApprovalToken('sender:token', 200)).toEqual({ ok: true });
		expect(await store.read('approval-uses-v1')).toEqual({ 'sender:token': 200 });
		expect(await authority.consumeApprovalToken('sender:token', 300)).toEqual({
			ok: false,
			reason: 'replayed',
		});
	});

	it('allows exactly one of two simultaneous first-use decisions', async () => {
		const store = createVolatileAuthorityStore();
		const authority = createWorkspaceAuthority({ store, clock, cap: 1024 });
		const results = await Promise.all([
			authority.consumeApprovalToken('sender:token', 200),
			authority.consumeApprovalToken('sender:token', 200),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'replayed' }]);
		expect(await store.read('approval-uses-v1')).toEqual({ 'sender:token': 200 });
	});

	it('returns no success when the awaited write throws and rolls back all staged writes', async () => {
		const store = createVolatileAuthorityStore();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failureStore: WorkspaceAuthorityStore = {
			...store,
			transaction: (decide) =>
				store.transaction((storage) =>
					decide({
						read: storage.read,
						write: async (key, value) => {
							await storage.write(key, value);
							entered.resolve();
							await release.promise;
							throw new Error('controlled write failure');
						},
					}),
				),
		};
		const authority = createWorkspaceAuthority({ store: failureStore, clock, cap: 1024 });
		let succeeded = false;
		const decision = authority.consumeApprovalToken('sender:token', 200).then(
			(result) => {
				succeeded = result.ok;
				return 'success';
			},
			(error: unknown) => (error instanceof Error ? error.message : 'unknown'),
		);
		await entered.promise;
		try {
			expect(succeeded).toBe(false);
		} finally {
			release.resolve();
		}
		expect(await decision).toBe('controlled write failure');
		expect(succeeded).toBe(false);
		expect(await store.read('approval-uses-v1')).toBeUndefined();
		expect(
			await createWorkspaceAuthority({ store, clock, cap: 1024 }).consumeApprovalToken(
				'sender:token',
				200,
			),
		).toEqual({ ok: true });
	});
});
