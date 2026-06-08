import { describe, expect, it } from 'vitest';

import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

describe('shouldRunLiveVmE2e', () => {
	it('requires an explicit opt-in flag for live VM integration tests', () => {
		expect(shouldRunLiveVmE2e({})).toBe(false);
		expect(shouldRunLiveVmE2e({ AGENT_VM_GONDOLIN_E2E: 'true' })).toBe(false);
		expect(shouldRunLiveVmE2e({ AGENT_VM_GONDOLIN_E2E: '1' })).toBe(true);
	});
});
