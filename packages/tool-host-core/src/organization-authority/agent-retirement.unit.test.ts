import { describe, expect, it } from 'vitest';

import { createOrganizationAuthority } from '#tool-host-core/organization-authority/organization-authority';
import { createVolatileAuthorityStore } from '#tool-host-core/organization-authority/volatile-authority-store';

describe('retired agent admission', () => {
	it('refuses a stale registration finishing after removal began', async () => {
		const store = createVolatileAuthorityStore();
		const authority = createOrganizationAuthority({
			store,
			clock: { nowMs: () => 100 },
			cap: 1024,
		});
		await authority.setAgentAdmission('agent-one', 'removed');
		await store.write('agent-retirement:agent-one', {
			kind: 'pending',
			requestId: 'b015079b-19b6-4aa2-9b82-1298efcb2f79',
		});
		await authority.setAgentAdmission('agent-one', 'listed').catch(() => undefined);
		expect(await authority.isAgentListed('agent-one')).toBe(false);
	});
});
