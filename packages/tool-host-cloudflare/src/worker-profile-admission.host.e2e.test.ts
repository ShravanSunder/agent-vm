import { expect, it } from 'vitest';

import { organizationOne } from '#worker-host/test-fixtures/controlled-mcp-issuer';
import { startLocalWorkerHarness } from '#worker-host/test-fixtures/local-worker-harness';

it.each(['missing membership', 'dangling persona'])(
	'real workerd refuses %s before upstream discovery',
	async (mode) => {
		const harness = await startLocalWorkerHarness();
		try {
			await harness.control({
				kind: 'admission',
				organizationId: organizationOne,
				agentId: 'agent-one',
				state: mode === 'missing membership' ? 'removed' : 'listed',
				persona: 'missing',
			});
			const response = await harness.rpc('tools/list');
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				error: mode === 'dangling persona' ? 'profile-unassigned' : 'unknown-caller',
			});
			expect(harness.fixture.initializations).toEqual([]);
			expect(harness.fixture.discoveryCredentials).toEqual([]);
			expect(harness.fixture.calls).toEqual([]);
		} finally {
			await harness.close();
		}
	},
);
