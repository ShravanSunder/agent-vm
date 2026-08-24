import { describe, expect, it } from 'vitest';

import { CONTROL_LEASE_RELIABILITY_SCENARIOS } from './control-lease-reliability-scenarios.js';

describe('CONTROL_LEASE_RELIABILITY_SCENARIOS', () => {
	it('declares the exact eight retained VM and Hermes proof filters', () => {
		expect(CONTROL_LEASE_RELIABILITY_SCENARIOS).toHaveLength(8);
		expect(
			new Set(CONTROL_LEASE_RELIABILITY_SCENARIOS.map(({ operationId }) => operationId)).size,
		).toBe(8);
		expect(CONTROL_LEASE_RELIABILITY_SCENARIOS).toContainEqual({
			operationId: 'controller-restart-cleanup',
			project: 'e2e-vm',
			requiresQueryIdentity: false,
			testFile: 'packages/agent-vm/src/integration-tests/controller-restart-cleanup.vm.e2e.test.ts',
		});
		expect(
			CONTROL_LEASE_RELIABILITY_SCENARIOS.filter(({ project }) => project === 'e2e-hermes'),
		).toHaveLength(5);
		expect(
			CONTROL_LEASE_RELIABILITY_SCENARIOS.filter(
				({ requiresQueryIdentity }) => requiresQueryIdentity,
			).map(({ operationId }) => operationId),
		).toEqual(['observability-pressure-isolation', 'recovery-no-flap']);
	});
});
