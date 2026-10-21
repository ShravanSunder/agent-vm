import { describe, expect, it } from 'vitest';

import { extractDirectOperationItem } from '#node-host/mcp-proxy-server/direct-operation-item';

describe('OD-S3b-1 direct caller item carrier', () => {
	it('accepts the same item across independent envelopes and the exact operation schema bound', () => {
		expect(extractDirectOperationItem({ 'tool-portal/operation-item': 'same-item' })).toBe(
			'same-item',
		);
		expect(extractDirectOperationItem({ 'tool-portal/operation-item': 'x'.repeat(1024) })).toBe(
			'x'.repeat(1024),
		);
	});
	it.each([
		undefined,
		{},
		{ 'tool-portal/operation-item': '' },
		{ 'tool-portal/operation-item': 1 },
		{ 'tool-portal/operation-item': 'x'.repeat(1025) },
		{ requestId: 'rpc-counter', sessionId: 'session' },
	])('refuses absent, malformed, oversized or transport-derived items: %j', (metadata) => {
		expect(extractDirectOperationItem(metadata)).toBeNull();
	});
});
