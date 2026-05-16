import { describe, expect, it } from 'vitest';

import { shouldRunLiveVmIntegration } from './live-integration-gates.js';

describe('shouldRunLiveVmIntegration', () => {
	it('requires an explicit opt-in flag for live VM integration tests', () => {
		expect(shouldRunLiveVmIntegration({})).toBe(false);
		expect(shouldRunLiveVmIntegration({ AGENT_VM_LIVE_VM_INTEGRATION: 'true' })).toBe(false);
		expect(shouldRunLiveVmIntegration({ AGENT_VM_LIVE_VM_INTEGRATION: '1' })).toBe(true);
	});
});
