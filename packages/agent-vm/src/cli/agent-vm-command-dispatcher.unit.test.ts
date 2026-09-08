import { parseSync } from '@optique/core';
import { describe, expect, it, vi } from 'vitest';

import { defaultCliDependencies } from './agent-vm-cli-support.js';
import {
	dispatchAgentVmCommand,
	type AgentVmCommandOperationSet,
} from './agent-vm-command-dispatcher.js';
import { agentVmRootParser } from './agent-vm-command-parser.js';

describe('Agent VM command dispatcher', () => {
	it('dispatches one inferred command to exactly one operation family', async () => {
		const parsed = parseSync(agentVmRootParser, ['init', 'zone']);
		if (!parsed.success) throw new Error('Expected init to parse.');
		const operationCalls = {
			auth: vi.fn(),
			backup: vi.fn(),
			build: vi.fn(),
			cache: vi.fn(),
			controller: vi.fn(),
			doctor: vi.fn(),
			init: vi.fn(),
			manual: vi.fn(),
			migrate: vi.fn(),
			paths: vi.fn(),
			validate: vi.fn(),
		} satisfies AgentVmCommandOperationSet;

		await dispatchAgentVmCommand(
			parsed.value,
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			defaultCliDependencies,
			operationCalls,
		);

		expect(operationCalls.init).toHaveBeenCalledTimes(1);
		expect(
			Object.values(operationCalls).reduce(
				(count, operation) => count + operation.mock.calls.length,
				0,
			),
		).toBe(1);
	});
});
