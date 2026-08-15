import { describe, expect, it } from 'vitest';

import { dispatchWorkerCommand } from './worker-cli-dispatcher.js';

describe('worker CLI dispatcher', () => {
	it.each([
		{ command: { command: 'health', port: 18_789 } as const, expectedOperation: 'health' },
		{
			command: {
				command: 'serve',
				config: undefined,
				port: 18_789,
				stateDir: undefined,
			} as const,
			expectedOperation: 'serve',
		},
	])('dispatches $expectedOperation exactly once', async ({ command, expectedOperation }) => {
		const operationsRun: string[] = [];

		await dispatchWorkerCommand(command, {
			runHealth: async () => {
				operationsRun.push('health');
			},
			runServe: async () => {
				operationsRun.push('serve');
			},
		});

		expect(operationsRun).toEqual([expectedOperation]);
	});
});
