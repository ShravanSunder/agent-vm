import { describe, expect, it } from 'vitest';

import { shouldRunGondolinBuildPipelineE2e } from './e2e-test-gates.js';

describe('shouldRunGondolinBuildPipelineE2e', () => {
	it('requires an explicit opt-in flag', () => {
		expect(shouldRunGondolinBuildPipelineE2e({})).toBe(false);
		expect(
			shouldRunGondolinBuildPipelineE2e({
				AGENT_VM_GONDOLIN_E2E: 'true',
			}),
		).toBe(false);
		expect(
			shouldRunGondolinBuildPipelineE2e({
				AGENT_VM_GONDOLIN_E2E: '1',
			}),
		).toBe(true);
	});
});
