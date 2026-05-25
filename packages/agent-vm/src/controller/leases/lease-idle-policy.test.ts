import { describe, expect, it } from 'vitest';

import {
	defaultToolVmLeaseIdleTtlMs,
	resolveToolVmLeaseIdleTtlMs,
	type ToolVmLeaseIdleTtlPolicy,
} from './lease-idle-policy.js';

describe('Tool VM lease idle policy', () => {
	it('uses the single default lease TTL when no request override is provided', () => {
		const policy = {
			defaultMs: defaultToolVmLeaseIdleTtlMs,
			maxRequestedMs: 24 * 60 * 60 * 1000,
			minRequestedMs: 1_000,
		} satisfies ToolVmLeaseIdleTtlPolicy;

		expect(resolveToolVmLeaseIdleTtlMs({ policy })).toEqual({
			kind: 'ok',
			value: 100 * 60 * 1000,
		});
	});

	it('accepts requested TTL inside configured bounds', () => {
		const policy = {
			defaultMs: defaultToolVmLeaseIdleTtlMs,
			maxRequestedMs: 24 * 60 * 60 * 1000,
			minRequestedMs: 1_000,
		} satisfies ToolVmLeaseIdleTtlPolicy;

		expect(resolveToolVmLeaseIdleTtlMs({ policy, requestedIdleTtlMs: 5_000 })).toEqual({
			kind: 'ok',
			value: 5_000,
		});
	});
});
