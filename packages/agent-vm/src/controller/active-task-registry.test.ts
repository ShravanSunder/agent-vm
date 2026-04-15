import { describe, expect, it } from 'vitest';

import { ActiveTaskRegistry } from './active-task-registry.js';

describe('ActiveTaskRegistry', () => {
	it('registers, resolves, and clears the active task for a zone', () => {
		const registry = new ActiveTaskRegistry();
		registry.register({
			taskId: 'task-1',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-1',
			branchPrefix: 'agent/',
			repos: [],
		});

		expect(registry.get('shravan', 'task-1')).toMatchObject({
			taskId: 'task-1',
			zoneId: 'shravan',
		});

		registry.clear('shravan', 'task-1');
		expect(registry.get('shravan', 'task-1')).toBeNull();
	});

	it('rejects a second active task for the same zone', () => {
		const registry = new ActiveTaskRegistry();
		registry.register({
			taskId: 'task-1',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-1',
			branchPrefix: 'agent/',
			repos: [],
		});

		expect(() =>
			registry.register({
				taskId: 'task-2',
				zoneId: 'shravan',
				taskRoot: '/tmp/task-2',
				branchPrefix: 'agent/',
				repos: [],
			}),
		).toThrow(/already has active task/u);
	});
});
