import { describe, expect, it } from 'vitest';

import {
	ApprovalPresentationOutcomeSchema,
	GatewayApprovalDecisionRequestSchema,
	GatewayApprovalDecisionResultSchema,
	GatewayApprovalPresentationRequestSchema,
	sanitizeGatewayApprovalArguments,
} from './gateway-approval-presentation-schema.js';

describe('Gateway approval presentation contracts', () => {
	it('accepts one bounded portable presentation request', () => {
		const request = {
			allowedDecisions: ['approve', 'deny'],
			challengeId: '998c404a-5c35-49ea-8479-1d856b122b7b',
			display: { argumentsPreview: '{"path":"docs/README.md"}' },
			expiresAt: '2026-08-20T21:00:00.000Z',
			itemId: 'call-a',
			name: 'read-file',
			namespace: 'controller',
		} as const;

		expect(GatewayApprovalPresentationRequestSchema.parse(request)).toEqual(request);
	});

	it('rejects a presentation preview whose UTF-8 encoding exceeds the byte bound', () => {
		const request = {
			allowedDecisions: ['approve', 'deny'],
			challengeId: '998c404a-5c35-49ea-8479-1d856b122b7b',
			display: { argumentsPreview: '🙂'.repeat(1_025) },
			expiresAt: '2026-08-20T21:00:00.000Z',
			itemId: 'call-a',
			name: 'read-file',
			namespace: 'controller',
		} as const;

		expect(GatewayApprovalPresentationRequestSchema.safeParse(request).success).toBe(false);
	});

	it.each([
		['standing approval decision', { kind: 'approved', scope: 'session' }],
		['unknown decision', { kind: 'always' }],
		['cancelled without a reason', { kind: 'cancelled' }],
		['unavailable with a cancellation reason', { kind: 'unavailable', reason: 'session-ended' }],
	] as const)('rejects %s', (_caseName, outcome) => {
		expect(ApprovalPresentationOutcomeSchema.safeParse(outcome).success).toBe(false);
	});

	it('accepts only challenge id and one decision in a private decision request', () => {
		const request = {
			challengeId: '998c404a-5c35-49ea-8479-1d856b122b7b',
			decision: 'approve',
		} as const;

		expect(GatewayApprovalDecisionRequestSchema.parse(request)).toEqual(request);
		expect(
			GatewayApprovalDecisionRequestSchema.safeParse({ ...request, approverId: 'forged' }).success,
		).toBe(false);
	});

	it('accepts explicit recorded and fail-closed decision results', () => {
		expect(
			GatewayApprovalDecisionResultSchema.parse({ kind: 'recorded', state: 'approved' }),
		).toEqual({ kind: 'recorded', state: 'approved' });
		expect(
			GatewayApprovalDecisionResultSchema.parse({ kind: 'rejected', reason: 'principal-mismatch' }),
		).toEqual({ kind: 'rejected', reason: 'principal-mismatch' });
	});
});

describe('sanitizeGatewayApprovalArguments', () => {
	it('redacts credential-shaped keys and string content', () => {
		const preview = sanitizeGatewayApprovalArguments({
			authorization: 'Bearer abc.def.ghi',
			nested: { note: 'token=secret-value', path: 'docs/README.md' },
		});

		expect(preview).toBe(
			'{"authorization":"[REDACTED]","nested":{"note":"[REDACTED]","path":"docs/README.md"}}',
		);
	});

	it('bounds depth, collection size, scalar length, and encoded bytes deterministically', () => {
		const oversized = Object.fromEntries(
			Array.from({ length: 40 }, (_value, index) => [
				`field-${String(index).padStart(2, '0')}`,
				'x'.repeat(300),
			]),
		);
		const firstPreview = sanitizeGatewayApprovalArguments({
			nested: { nested: { nested: { nested: { nested: { nested: oversized } } } } },
		});
		const secondPreview = sanitizeGatewayApprovalArguments({
			nested: { nested: { nested: { nested: { nested: { nested: oversized } } } } },
		});

		expect(firstPreview).toBe(secondPreview);
		expect(firstPreview).toContain('[TRUNCATED]');
		expect(new TextEncoder().encode(firstPreview).byteLength).toBeLessThanOrEqual(4_096);
	});
});
