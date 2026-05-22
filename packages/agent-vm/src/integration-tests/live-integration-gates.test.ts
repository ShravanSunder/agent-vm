import { describe, expect, it } from 'vitest';

import { shouldRunLiveVmIntegration } from './live-integration-gates.js';

describe('shouldRunLiveVmIntegration', () => {
	it('requires an explicit opt-in flag for live VM integration tests', () => {
		expect(shouldRunLiveVmIntegration({})).toBe(false);
		expect(shouldRunLiveVmIntegration({ AGENT_VM_GONDOLIN_SMOKE: 'true' })).toBe(false);
		expect(shouldRunLiveVmIntegration({ AGENT_VM_GONDOLIN_SMOKE: '1' })).toBe(true);
	});
});
