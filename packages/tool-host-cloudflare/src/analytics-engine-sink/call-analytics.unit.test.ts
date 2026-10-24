import { writeCallAnalytics, type CallAnalytics } from '@agent-collaboration/tool-host-core';
import { describe, expect, it } from 'vitest';

import {
	analyticsText,
	createAnalyticsEngineSink,
} from '#worker-host/analytics-engine-sink/analytics-engine-sink';

const call: CallAnalytics = {
	organizationId: '11111111-1111-4111-8111-111111111111',
	workspaceId: '22222222-2222-4222-8222-222222222222',
	workspaceName: 'workspace',
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
			sink: createAnalyticsEngineSink({ writeDataPoint: (point) => points.push(point) }),
			call,
			log: () => {
				throw new Error('unexpected');
			},
		});
		expect(points).toEqual([
			{
				indexes: [call.workspaceId],
				blobs: [
					call.organizationId,
					'workspace',
					'agent',
					'direct',
					'server',
					'tool',
					'ran',
					'none',
					'no',
				],
				doubles: [1, 2, 3],
			},
		]);
	});
	it('caps every free text blob at the sink boundary, including synthetic organization text', () => {
		const points: unknown[] = [];
		const text = 'a'.repeat(253) + '𐀀'.repeat(100);
		createAnalyticsEngineSink({ writeDataPoint: (point) => points.push(point) }).write({
			...call,
			organizationId: text,
			workspaceName: text,
			agentName: text,
			serverName: text,
			toolName: text,
		});
		expect(points).toEqual([
			{
				indexes: [call.workspaceId],
				blobs: [
					text.slice(0, 253),
					text.slice(0, 253),
					text.slice(0, 253),
					'direct',
					text.slice(0, 253),
					text.slice(0, 253),
					'ran',
					'none',
					'no',
				],
				doubles: [1, 2, 3],
			},
		]);
	});
	it('drops a failing write and logs no binding error or call contents', () => {
		const logs: unknown[] = [];
		expect(() =>
			writeCallAnalytics({
				sink: createAnalyticsEngineSink({
					writeDataPoint: () => {
						throw new Error('secret-token-canary');
					},
				}),
				call,
				log: (event) => logs.push(event),
			}),
		).not.toThrow();
		expect(logs).toEqual([{ event: 'analytics-write-dropped' }]);
	});
});
