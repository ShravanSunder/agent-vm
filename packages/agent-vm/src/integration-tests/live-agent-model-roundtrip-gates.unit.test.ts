import { describe, expect, it } from 'vitest';

import { shouldRunLiveModelRoundtripE2e } from './live-agent-model-roundtrip-gates.js';

describe('shouldRunLiveModelRoundtripE2e', () => {
	it('keeps inventory closed when credentials exist without the explicit LLM e2e gate', () => {
		expect(
			shouldRunLiveModelRoundtripE2e({
				canReadConfiguredZoneSecretRefs: () => true,
				env: {
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-model-token',
					AGENT_VM_TEST_OP_REFS: 'op://agent-vm-testing/item/password',
					AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-op-token',
				},
			}),
		).toBe(false);
	});

	it('requires readable test-vault refs when the LLM e2e gate is open', () => {
		expect(
			shouldRunLiveModelRoundtripE2e({
				canReadConfiguredZoneSecretRefs: () => false,
				env: {
					AGENT_VM_LLM_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-model-token',
					AGENT_VM_TEST_OP_REFS: 'op://agent-vm-testing/item/password',
					AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-op-token',
				},
			}),
		).toBe(false);
	});

	it('allows the live LLM roundtrip only with explicit gate, model token, and readable test refs', () => {
		expect(
			shouldRunLiveModelRoundtripE2e({
				canReadConfiguredZoneSecretRefs: () => true,
				env: {
					AGENT_VM_LLM_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-model-token',
					AGENT_VM_TEST_OP_REFS: 'op://agent-vm-testing/item/password',
					AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-op-token',
				},
			}),
		).toBe(true);
	});
});
