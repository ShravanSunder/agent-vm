import { describe, expect, it } from 'vitest';

import { verifyGatewayLifecycleContracts } from '../contract-fixtures/gateway-lifecycle-contract-verifier.js';

describe('gateway-lifecycle compile contracts', () => {
	it('accepts a language-neutral Python guest lifecycle and rejects forbidden imports', () => {
		const verification = verifyGatewayLifecycleContracts();

		expect(verification.positiveDiagnostics).toEqual([]);
		expect(verification.positiveFixtureUsesForbiddenGatewaySpecificSurface).toBe(false);
		expect(verification.negativeFixtures).toEqual([
			{
				fixtureName: 'concrete-adapter-import',
				matchedExpectedDiagnostic: true,
			},
			{
				fixtureName: 'old-package-import',
				matchedExpectedDiagnostic: true,
			},
		]);
	});
});
