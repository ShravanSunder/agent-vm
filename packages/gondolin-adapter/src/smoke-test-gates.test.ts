import { describe, expect, it } from 'vitest';

import { shouldRunGondolinBuildPipelineSmoke } from './smoke-test-gates.js';

describe('shouldRunGondolinBuildPipelineSmoke', () => {
	it('requires an explicit opt-in flag', () => {
		expect(shouldRunGondolinBuildPipelineSmoke({})).toBe(false);
		expect(
			shouldRunGondolinBuildPipelineSmoke({
				AGENT_VM_GONDOLIN_SMOKE: 'true',
			}),
		).toBe(false);
		expect(
			shouldRunGondolinBuildPipelineSmoke({
				AGENT_VM_GONDOLIN_SMOKE: '1',
			}),
		).toBe(true);
	});
});
