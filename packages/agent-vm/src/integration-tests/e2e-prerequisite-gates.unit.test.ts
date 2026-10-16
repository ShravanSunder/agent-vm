import { describe, expect, it, vi } from 'vitest';

import { canRunManagedVmE2e } from './e2e-harness.js';
import { shouldRunHermesE2e } from './hermes-e2e-harness.js';

vi.mock('../build/zig-compatibility.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../build/zig-compatibility.js')>()),
	resolveHostZigVersion: vi.fn(async () => undefined),
}));

describe('canRunManagedVmE2e', () => {
	it('admits published-helper proof without a host compiler', async () => {
		expect(
			await canRunManagedVmE2e({
				architecture: 'aarch64',
				commandExists: () => true,
			}),
		).toBe(true);
	});
	it.each(['docker', 'qemu-system-aarch64'])(
		'rejects missing actual prerequisite %s',
		async (missingCommand) => {
			expect(
				await canRunManagedVmE2e({
					architecture: 'aarch64',
					commandExists: (command) => command !== missingCommand,
				}),
			).toBe(false);
		},
	);
});

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
			}),
		).toBe(true);
	});
});
