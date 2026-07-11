import { describe, expect, it } from 'vitest';

import {
	createCompleteVmDestroyReceipt,
	createTestVmDestroyTarget,
} from '../testing/managed-vm-test-helpers.js';
import {
	assertVmDestroyReceiptMatchesTarget,
	containsIncompleteVmDestructionError,
	containsUnprovenVmDestructionError,
	IncompleteVmDestructionError,
	VmDestructionReceiptMismatchError,
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

	it('classifies an incomplete wrong-target receipt as incomplete before target matching', () => {
		const expectedTarget = createTestVmDestroyTarget('expected-target');
		const incompleteWrongTargetReceipt = {
			...createCompleteVmDestroyReceipt('wrong-target'),
			complete: false,
		} as const;

		expect(() =>
			assertVmDestroyReceiptMatchesTarget(
				incompleteWrongTargetReceipt,
				expectedTarget,
				'Tool VM cleanup',
			),
		).toThrow(IncompleteVmDestructionError);
	});

	it('classifies a complete wrong-target receipt as a target mismatch', () => {
		const expectedTarget = createTestVmDestroyTarget('expected-target');
		const completeWrongTargetReceipt = createCompleteVmDestroyReceipt('wrong-target');

		expect(() =>
			assertVmDestroyReceiptMatchesTarget(
				completeWrongTargetReceipt,
				expectedTarget,
				'Tool VM cleanup',
			),
		).toThrow(VmDestructionReceiptMismatchError);
	});
});
