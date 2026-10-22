import { describe, expect, it } from 'vitest';

import {
	assertBatchLimit,
	assertBodyLimit,
	assertBoundedLargeReply,
	assertSameIsolateOverlap,
	assertSixInFlight,
	assertUpstreamBoundary,
} from '#worker-host/deployed-checks/deployed-check-suites/limit-observations';
import type {
	PortalResponseObservation,
	TailRecord,
} from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';
import type { RunObservations } from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';
import { emptyObservations } from '#worker-host/deployed-checks/test-helper-worker/observation-counters';

function observedCalls(callIds: readonly string[]): RunObservations {
	return {
		runId: 'unit',
		activeCalls: 0,
		peakCalls: 6,
		calls: callIds.map((callId) => ({
			callId,
			organizationLabel: 'alpha',
			toolName: 'read',
			credential: 'own',
			effects: 1,
			inFlight: 0,
		})),
	};
}
const success = { status: 200, result: {}, bytes: 100 };
const tooLarge = {
	status: 200,
	result: { isError: true, content: [{ text: 'too_large_result' }] },
	bytes: 100,
};
function overlapRecords(): TailRecord[] {
	return Array.from({ length: 3 }, (_, index) => ({
		outcome: 'ok',
		event: { request: { url: 'https://portal.invalid/mcp?runId=unit' } },
		eventTimestamp: 100,
		logs: [
			{
				timestamp: index,
				message: [
					JSON.stringify({
						event: 'request-started',
						isolateId: 'one-isolate',
						requestId: `request-${String(index)}`,
						activeRequests: index + 1,
					}),
				],
			},
			{
				timestamp: 10 + index,
				message: [
					JSON.stringify({
						event: 'request-ended',
						isolateId: 'one-isolate',
						requestId: `request-${String(index)}`,
						activeRequests: 2 - index,
					}),
				],
			},
		],
	}));
}
describe('deployed limit assertion sensitivity', () => {
	it.each([200, 403, 502])(
		'reports the observed HTTP %s when an oversized body is not refused',
		(status) => {
			expect(() =>
				assertBodyLimit(
					[success, success, { ...success, status }],
					observedCalls(['under', 'at']),
					['under', 'at', 'over'],
				),
			).toThrow(`Oversized body was not refused with 413 (got HTTP ${String(status)}).`);
		},
	);
	it('accepts under/at body limit and rejects a moved cap or effects after rejection', () => {
		const ids = ['under', 'at', 'over'];
		const calls = observedCalls(['under', 'at']);
		expect(() =>
			assertBodyLimit([success, success, { ...success, status: 413 }], calls, ids),
		).not.toThrow();
		expect(() =>
			assertBodyLimit(
				[success, { ...success, status: 413 }, { ...success, status: 413 }],
				calls,
				ids,
			),
		).toThrow();
		expect(() => assertBodyLimit([success, success, success], observedCalls(ids), ids)).toThrow();
	});
	it('accepts fifty effects and rejects fifty-one being served or a vacuous control', () => {
		const ids = Array.from({ length: 50 }, (_, index) => String(index));
		expect(() => assertBatchLimit(success, observedCalls(ids), ids, true)).not.toThrow();
		expect(() => assertBatchLimit(success, emptyObservations('unit'), ids, true)).toThrow();
		const refusal = { ...tooLarge, result: { isError: true, reason: 'too_many_calls' } };
		expect(() =>
			assertBatchLimit(refusal, emptyObservations('unit'), [...ids, 'extra'], false),
		).not.toThrow();
		expect(() =>
			assertBatchLimit(success, observedCalls([...ids, 'extra']), [...ids, 'extra'], false),
		).toThrow();
	});
	it('accepts twelve completed calls with six in flight and rejects seven or missing effects', () => {
		const ids = Array.from({ length: 12 }, (_, index) => String(index));
		const snapshot = observedCalls(ids);
		expect(() => assertSixInFlight(snapshot, ids)).not.toThrow();
		expect(() => assertSixInFlight({ ...snapshot, peakCalls: 7 }, ids)).toThrow();
		expect(() => assertSixInFlight({ ...snapshot, calls: [] }, ids)).toThrow();
	});
	it('requires bounded explicit too-large responses, rejects crashes and over-limit replies', () => {
		expect(() => assertBoundedLargeReply(tooLarge)).not.toThrow();
		expect(() => assertBoundedLargeReply({ ...tooLarge, bytes: 16 * 1024 * 1024 + 1 })).toThrow();
		expect(() => assertBoundedLargeReply({ ...tooLarge, status: 500 })).toThrow();
		expect(() => assertBoundedLargeReply(success)).toThrow();
	});
	it('checks actual retained upstream bytes and rejects truncation or an over-limit success', () => {
		const result = { content: [{ type: 'text', text: 'retained' }] };
		const response: PortalResponseObservation = {
			status: 200,
			bytes: 100,
			result: {
				content: [
					{
						text: JSON.stringify({ items: [{ status: 'success', structuredContent: { result } }] }),
					},
				],
			},
		};
		expect(() =>
			assertUpstreamBoundary(response, JSON.stringify(result).length, true),
		).not.toThrow();
		expect(() =>
			assertUpstreamBoundary(response, JSON.stringify(result).length + 1, true),
		).toThrow();
		expect(() => assertUpstreamBoundary(response, 0, false)).toThrow();
		expect(() =>
			assertUpstreamBoundary(
				{ ...tooLarge, result: { isError: true, reason: 'upstream_call_failed' } },
				0,
				false,
			),
		).not.toThrow();
	});
	it('counts only three genuinely overlapping requests in the same isolate, with runtime failures rejected', () => {
		const records = overlapRecords();
		expect(() => assertSameIsolateOverlap(records, 'unit')).not.toThrow();
		expect(() =>
			assertSameIsolateOverlap(
				records.map((record, index) => ({
					...record,
					logs: record.logs.map((log) => ({
						...log,
						message: log.message.map((message) =>
							String(message).replaceAll('one-isolate', `isolate-${String(index)}`),
						),
					})),
				})),
				'unit',
			),
		).toThrow('INCONCLUSIVE');
		expect(() =>
			assertSameIsolateOverlap(
				records.map((record, index) => ({
					...record,
					logs: record.logs.map((log) => ({ ...log, timestamp: log.timestamp + index * 20 })),
				})),
				'unit',
			),
		).toThrow('INCONCLUSIVE');
		expect(() =>
			assertSameIsolateOverlap(
				records.map((record) => ({ ...record, outcome: 'exceededMemory' })),
				'unit',
			),
		).toThrow();
		expect(() => assertSameIsolateOverlap([], 'unit')).toThrow();
	});
});
