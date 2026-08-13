import { describe, expect, it } from 'vitest';

import { shouldRunWorkerGatewayE2e } from './e2e-harness.js';
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

describe('shouldRunWorkerGatewayE2e', () => {
	it('requires explicit opt-in even when credentials and commands are available', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { AGENT_VM_TEST_OPENAI_API_KEY: 'test-token' },
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires a model credential when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { AGENT_VM_WORKER_E2E: '1' },
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires QEMU and Docker when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: (command) => command !== 'docker',
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(false);
	});

	it('requires a compatible Zig version when explicitly enabled', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.15.2',
			}),
		).toBe(false);
	});

	it('allows the worker gateway smoke when opt-in, credentials, commands, and Zig are compatible', async () => {
		expect(
			await shouldRunWorkerGatewayE2e({
				architecture: 'aarch64',
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				resolveRequiredZigVersion: async () => '0.16.0',
				resolveZigVersion: async () => '0.16.0',
			}),
		).toBe(true);
	});
});
