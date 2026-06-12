import { describe, expect, it } from 'vitest';

import { startControllerRuntime, type ControllerRuntimeDependencies } from './index.js';

describe('package entrypoint', () => {
	it('exports the controller runtime embedding entrypoint and hook dependency types', () => {
		const dependencies: ControllerRuntimeDependencies = {
			onWorkerTaskPrepared: async () => {},
			onWorkerTaskIngress: async () => {},
			onWorkerTaskFinished: async () => {},
		};

		expect(typeof startControllerRuntime).toBe('function');
		expect(dependencies).toHaveProperty('onWorkerTaskPrepared');
	});
});
