import { describe, expect, it } from 'vitest';

import { createCompleteVmDestroyReceipt } from '../testing/managed-vm-test-helpers.js';
import {
	containsIncompleteVmDestructionError,
	containsUnprovenVmDestructionError,
	IncompleteVmDestructionError,
	VmDestructionUnprovenError,
} from './vm-destruction-receipt.js';

describe('VM destruction receipt errors', () => {
	it('finds an incomplete receipt through nested aggregate causes', () => {
		const incompleteReceipt = {
			...createCompleteVmDestroyReceipt('nested-incomplete'),
			complete: false,
		} as const;
		const incompleteError = new IncompleteVmDestructionError('nested cleanup', incompleteReceipt);
		const innerAggregate = new AggregateError([new Error('primary'), incompleteError]);
		const outerError = new Error('outer', { cause: innerAggregate });

		expect(containsIncompleteVmDestructionError(outerError)).toBe(true);
		expect(containsUnprovenVmDestructionError(outerError)).toBe(true);
		expect(containsIncompleteVmDestructionError(new Error('ordinary failure'))).toBe(false);
	});

	it('finds a thrown close failure marked unproven without calling it incomplete', () => {
		const closeError = new VmDestructionUnprovenError('VM close threw', {
			cause: new Error('transport failed'),
		});
		const aggregateError = new AggregateError([new Error('primary'), closeError]);

		expect(containsUnprovenVmDestructionError(aggregateError)).toBe(true);
		expect(containsIncompleteVmDestructionError(aggregateError)).toBe(false);
	});
});
