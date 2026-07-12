import { describe, expect, it } from 'vitest';

import { verifyManagedVmContracts } from './verify-managed-vm-contracts.js';

describe('managed-vm compile contracts', () => {
	it('accepts the neutral fake provider and rejects forbidden consumer access', () => {
		const verification = verifyManagedVmContracts();

		expect(verification.positiveDiagnostics).toEqual([]);
		expect(verification.negativeFixtures).toEqual([
			{
				fixtureName: 'aggregate-provider-consumer',
				matchedExpectedDiagnostic: true,
			},
			{
				fixtureName: 'closed-contract-variants',
				matchedExpectedDiagnostic: true,
			},
			{
				fixtureName: 'native-escape-hatches',
				matchedExpectedDiagnostic: true,
			},
		]);
	});
});
