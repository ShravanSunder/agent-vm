import { describe, expect, it } from 'vitest';

import { shouldRunWorkerGatewaySmoke } from './smoke-harness.js';

describe('shouldRunWorkerGatewaySmoke', () => {
	it('requires explicit opt-in even when credentials and commands are available', () => {
		expect(
			shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { OPEN_AI_TEST_KEY: 'test-token' },
			}),
		).toBe(false);
	});

	it('requires a model credential when explicitly enabled', () => {
		expect(
			shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: () => true,
				env: { AGENT_VM_WORKER_LOOP_SMOKE: '1' },
			}),
		).toBe(false);
	});

	it('requires QEMU, Zig, and Docker when explicitly enabled', () => {
		expect(
			shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: (command) => command !== 'docker',
				env: {
					AGENT_VM_WORKER_LOOP_SMOKE: '1',
					OPEN_AI_TEST_KEY: 'test-token',
				},
			}),
		).toBe(false);
	});

	it('allows the worker gateway smoke when opt-in, credentials, and commands are present', () => {
		expect(
			shouldRunWorkerGatewaySmoke({
				architecture: 'aarch64',
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_LOOP_SMOKE: '1',
					OPEN_AI_TEST_KEY: 'test-token',
				},
			}),
		).toBe(true);
	});
});
