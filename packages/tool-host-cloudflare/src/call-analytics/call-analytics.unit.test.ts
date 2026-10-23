import { describe, expect, it } from 'vitest';

import {
	analyticsText,
	writeCallAnalytics,
	type CallAnalytics,
} from '#worker-host/call-analytics/call-analytics';

const call: CallAnalytics = {
	organizationId: '11111111-1111-4111-8111-111111111111',
	organizationName: 'org',
	agentName: 'agent',
	mode: 'direct',
	serverName: 'server',
	toolName: 'tool',
	outcome: 'ran',
	failureKind: 'none',
	durationMs: 1,
	requestBytes: 2,
	responseBytes: 3,
};
describe('safe bounded call analytics', () => {
	it.each(['a'.repeat(300), '𐀀'.repeat(100), 'é'.repeat(200), 'a'.repeat(255) + '𐀀'])(
		'caps UTF8 bytes on a character boundary',
		(value) => {
			const output = analyticsText(value);
			const bytes = new TextEncoder().encode(output);
			expect(bytes.byteLength).toBeLessThanOrEqual(256);
			expect(value.startsWith(output)).toBe(true);
			expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(output);
			expect(output.length).toBeGreaterThan(0);
		},
	);
	it('writes one point with the exact field order and numeric shape', () => {
		const points: unknown[] = [];
		writeCallAnalytics({
			binding: { writeDataPoint: (point) => points.push(point) },
			call,
			log: () => {
				throw new Error('unexpected');
			},
		});
		expect(points).toEqual([
			{
				indexes: [call.organizationId],
				blobs: ['org', 'agent', 'direct', 'server', 'tool', 'ran', 'none', 'no'],
				doubles: [1, 2, 3],
			},
		]);
	});
	it('drops a failing write and logs no binding error or call contents', () => {
		const logs: unknown[] = [];
		expect(() =>
			writeCallAnalytics({
				binding: {
					writeDataPoint: () => {
						throw new Error('secret-token-canary');
					},
				},
				call,
				log: (event) => logs.push(event),
			}),
		).not.toThrow();
		expect(logs).toEqual([{ event: 'analytics-write-dropped' }]);
	});
});
