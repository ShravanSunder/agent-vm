import { describe, expect, it } from 'vitest';

import {
	MANAGED_VM_EXACT_LIFECYCLE_CONTRACT_VERSION,
	assertManagedVmExactLifecycleContractVersion,
} from './exact-vm-lifecycle.js';

describe('exact VM lifecycle adapter contract', () => {
	it('pins and accepts only lifecycle contract version 1', () => {
		expect(MANAGED_VM_EXACT_LIFECYCLE_CONTRACT_VERSION).toBe(1);
		expect(() => assertManagedVmExactLifecycleContractVersion(1)).not.toThrow();
		expect(() => assertManagedVmExactLifecycleContractVersion(2)).toThrow(
			/unsupported Gondolin exact VM lifecycle contract version/u,
		);
	});
});
