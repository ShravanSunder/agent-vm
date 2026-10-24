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
		await authority.beginAgentRemoval('agent-one', requestId, 'disable');
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
		await authority.beginAgentRemoval('agent-one', requestId, 'unlink');
		expect(await store.read('member:agent-one')).toBeUndefined();
		expect(await authority.readAgentRemoval('agent-one')).toEqual({
			kind: 'pending',
			operation: 'unlink',
			requestId,
		});
	});
});
