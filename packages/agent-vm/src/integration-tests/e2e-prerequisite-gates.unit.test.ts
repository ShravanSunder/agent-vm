import { describe, expect, it } from 'vitest';

import { shouldRunHermesE2e } from './hermes-e2e-harness.js';

describe('shouldRunHermesE2e', () => {
	it('keeps inventory mode skipped when live Hermes proof is not requested', async () => {
		expect(
			await shouldRunHermesE2e({
				architecture: 'aarch64',
				commandExists: () => false,
				env: {},
			}),
		).toBe(false);
	});

	it('fails explicit Hermes proof when managed VM prerequisites are unavailable', async () => {
		await expect(
			shouldRunHermesE2e({
				architecture: 'aarch64',
				commandExists: () => false,
				env: { AGENT_VM_HERMES_E2E: '1' },
			}),
		).rejects.toThrow('explicitly requested live Hermes proof');
	});

	it('runs explicit Hermes proof when managed VM prerequisites are available', async () => {
		expect(
			await shouldRunHermesE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { AGENT_VM_HERMES_E2E: '1' },
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(true);
	});
});
