import { describe, expect, it } from 'vitest';

import { shouldRunLiveModelRoundtripE2e } from './live-agent-model-roundtrip-gates.js';

describe('shouldRunLiveModelRoundtripE2e', () => {
	it('keeps inventory closed when credentials exist without the explicit LLM e2e gate', () => {
		expect(
			shouldRunLiveModelRoundtripE2e({
				env: {
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-model-token',
				},
			}),
		).toBe(false);
	});

	it('requires the test-only model token when the LLM e2e gate is open', () => {
		expect(
			shouldRunLiveModelRoundtripE2e({
				env: {
					AGENT_VM_LLM_E2E: '1',
				},
			}),
		).toBe(false);
	});

	it('allows the live LLM roundtrip only with the explicit gate and model token', () => {
		expect(
			shouldRunLiveModelRoundtripE2e({
				env: {
					AGENT_VM_LLM_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-model-token',
				},
			}),
		).toBe(true);
	});
});
