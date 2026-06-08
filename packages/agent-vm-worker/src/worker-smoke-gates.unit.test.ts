import { describe, expect, it } from 'vitest';

import { shouldRunWorkerRuntimeSmoke } from './worker-smoke-gates.js';

describe('shouldRunWorkerRuntimeSmoke', () => {
	it('requires explicit opt-in even when credentials and codex are available', () => {
		expect(
			shouldRunWorkerRuntimeSmoke({
				commandExists: () => true,
				env: { OPEN_AI_TEST_KEY: 'test-token' },
			}),
		).toBe(false);
	});

	it('requires a model credential when explicitly enabled', () => {
		expect(
			shouldRunWorkerRuntimeSmoke({
				commandExists: () => true,
				env: { AGENT_VM_WORKER_SMOKE: '1' },
			}),
		).toBe(false);
	});

	it('requires the codex command when explicitly enabled', () => {
		expect(
			shouldRunWorkerRuntimeSmoke({
				commandExists: () => false,
				env: {
					AGENT_VM_WORKER_SMOKE: '1',
					OPEN_AI_TEST_KEY: 'test-token',
				},
			}),
		).toBe(false);
	});

	it('allows the worker runtime smoke when opt-in, credentials, and codex are present', () => {
		expect(
			shouldRunWorkerRuntimeSmoke({
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_SMOKE: '1',
					OPEN_AI_TEST_KEY: 'test-token',
				},
			}),
		).toBe(true);
	});
});
