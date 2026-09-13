import { describe, expect, it } from 'vitest';

import { createOperationFileRetentionBudget } from './operation-file-retention-budget.js';

describe('agent-scoped retained file bytes', () => {
	it('shares the cap across VM owners without releasing another owner on source retirement', () => {
		// Arrange
		const budget = createOperationFileRetentionBudget();
		const source = budget.forOwner({ agentId: 'sun', zoneId: 'zone', ownerId: 'source-vm' });
		const native = budget.forOwner({ agentId: 'sun', zoneId: 'zone', ownerId: 'native-stage' });
		// Act / Assert
		expect(source.reserve('result', 48 * 1024 * 1024)).toBe(true);
		expect(native.reserve('sending', 16 * 1024 * 1024)).toBe(true);
		expect(native.reserve('extra', 1)).toBe(false);
		source.releaseAllAfterCleanup();
		expect(native.retainedBytes()).toBe(16 * 1024 * 1024);
		expect(source.reserve('new-result', 49 * 1024 * 1024)).toBe(false);
		expect(source.reserve('new-result', 48 * 1024 * 1024)).toBe(true);
	});
	it('isolates agents and permits only shrinking a completed reservation', () => {
		// Arrange
		const budget = createOperationFileRetentionBudget();
		const sun = budget.forOwner({ agentId: 'sun', zoneId: 'zone', ownerId: 'vm' });
		const ember = budget.forOwner({ agentId: 'ember', zoneId: 'zone', ownerId: 'vm' });
		// Act / Assert
		expect(sun.reserve('file', 64 * 1024 * 1024)).toBe(true);
		expect(ember.reserve('file', 64 * 1024 * 1024)).toBe(true);
		expect(sun.resize('file', 100)).toBe(true);
		expect(sun.resize('file', 101)).toBe(false);
		expect(ember.retainedBytes()).toBe(64 * 1024 * 1024);
		sun.releaseAfterCleanup('missing');
		expect(sun.retainedBytes()).toBe(100);
	});
});
