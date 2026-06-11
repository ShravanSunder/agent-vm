import { describe, expect, it } from 'vitest';

import { resolveWorkerRuntimeEntrypoint, shouldRunWorkerRuntimeE2e } from './worker-e2e-gates.js';

describe('resolveWorkerRuntimeEntrypoint', () => {
	it('points worker e2e at the built artifact instead of rebuilding in the test body', () => {
		expect(resolveWorkerRuntimeEntrypoint('/repo/agent-vm')).toBe(
			'/repo/agent-vm/packages/agent-vm-worker/dist/main.js',
		);
	});
});

describe('shouldRunWorkerRuntimeE2e', () => {
	it('requires explicit opt-in even when credentials and codex are available', () => {
		expect(
			shouldRunWorkerRuntimeE2e({
				commandExists: () => true,
				env: { AGENT_VM_TEST_OPENAI_API_KEY: 'test-token' },
				provider: 'codex',
			}),
		).toBe(false);
	});

	it('requires a model credential when explicitly enabled', () => {
		expect(
			shouldRunWorkerRuntimeE2e({
				commandExists: () => true,
				env: { AGENT_VM_WORKER_E2E: '1' },
				provider: 'codex',
			}),
		).toBe(false);
	});

	it('requires the codex command when explicitly enabled', () => {
		expect(
			shouldRunWorkerRuntimeE2e({
				commandExists: () => false,
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				provider: 'codex',
			}),
		).toBe(false);
	});

	it('allows the worker runtime smoke when opt-in, credentials, and codex are present', () => {
		expect(
			shouldRunWorkerRuntimeE2e({
				commandExists: () => true,
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_OPENAI_API_KEY: 'test-token',
				},
				provider: 'codex',
			}),
		).toBe(true);
	});

	it('allows the claude worker runtime smoke with Anthropic credentials and claude command', () => {
		expect(
			shouldRunWorkerRuntimeE2e({
				commandExists: (command) => command === 'claude',
				env: {
					AGENT_VM_WORKER_E2E: '1',
					AGENT_VM_TEST_ANTHROPIC_API_KEY: 'test-token',
				},
				provider: 'claude',
			}),
		).toBe(true);
	});
});
