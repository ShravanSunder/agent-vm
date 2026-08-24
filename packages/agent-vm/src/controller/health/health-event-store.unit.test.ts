import { Buffer } from 'node:buffer';

import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it, vi } from 'vitest';

import { HealthEventStore } from './health-event-store.js';

function gatewayControlSessionEvent(
	overrides: Partial<AgentVmHealthEvent> = {},
): AgentVmHealthEvent {
	return {
		domain: 'gateway_control',
		elapsedMs: 12,
		kind: 'gateway-control-session',
		observedAtMs: 1_000,
		operation: 'control-session-heartbeat',
		peerId: 'gateway-beta',
		result: 'ok',
		zoneId: 'beta',
		...overrides,
	} as AgentVmHealthEvent;
}

type GatewayControlSessionEvent = Extract<
	AgentVmHealthEvent,
	{ readonly kind: 'gateway-control-session' }
>;

function reconnectEvent(
	overrides: Partial<GatewayControlSessionEvent> = {},
): GatewayControlSessionEvent {
	return {
		attemptCount: 0,
		bootId: 'gateway-boot-a',
		domain: 'gateway_control',
		elapsedMs: 0,
		firstObservedAtMs: 1_000,
		kind: 'gateway-control-session',
		latestObservedAtMs: 1_000,
		observedAtMs: 1_000,
		operation: 'control-session-reconnect',
		outcome: 'stale-attachment',
		peerId: 'gateway-beta',
		reconnectPhase: 'attachment-lost',
		result: 'failed',
		windowState: 'open',
		zoneId: 'beta',
		...overrides,
	} as GatewayControlSessionEvent;
}

describe('HealthEventStore', () => {
	it('keeps the latest event per zone and health bucket', () => {
		const store = new HealthEventStore({ eventHistoryLimit: 10, staleAfterMs: 30_000 });

		store.record(gatewayControlSessionEvent({ observedAtMs: 1_000, result: 'failed' }));
		store.record(gatewayControlSessionEvent({ observedAtMs: 2_000, result: 'ok' }));

		expect(store.listLatestEventsForZone('beta')).toEqual([
			gatewayControlSessionEvent({ observedAtMs: 2_000, result: 'ok' }),
		]);
		expect(store.deriveSnapshot({ nowMs: 3_000, zoneId: 'beta' })).toMatchObject({
			kind: 'ok',
			zoneId: 'beta',
		});
	});

	it('bounds retained event history independently from latest state', () => {
		const store = new HealthEventStore({ eventHistoryLimit: 2, staleAfterMs: 30_000 });

		store.record(gatewayControlSessionEvent({ observedAtMs: 1_000 }));
		store.record(
			gatewayControlSessionEvent({
				kind: 'gateway-service-health',
				observedAtMs: 2_000,
				port: 18789,
				statusCode: 200,
			}),
		);
		store.record(
			gatewayControlSessionEvent({
				gatewayService: 'hermes',
				kind: 'gateway-plugin-health',
				observedAtMs: 3_000,
				state: 'ready',
			}),
		);

		expect(store.listHistory()).toHaveLength(2);
		expect(store.listHistory().map((event) => event.observedAtMs)).toEqual([2_000, 3_000]);
		expect(store.listLatestEventsForZone('beta')).toHaveLength(3);
	});

	it('bounds latest event buckets for transient lease identifiers', () => {
		const store = new HealthEventStore({
			eventHistoryLimit: 20,
			latestBucketLimit: 2,
			staleAfterMs: 30_000,
		});

		for (let index = 0; index < 4; index += 1) {
			store.record({
				agentId: 'beta',
				elapsedMs: 12,
				kind: 'lease-heartbeat',
				leaseId: `lease-${String(index)}`,
				observedAtMs: 1_000 + index,
				result: 'ok',
				useId: `use-${String(index)}`,
				zoneId: 'beta',
			});
		}

		expect(store.listLatestEventsForZone('beta').map((event) => event.observedAtMs)).toEqual([
			1_003, 1_002,
		]);
	});

	it('keeps caller-context diagnostics out of authoritative latest-bucket capacity', () => {
		const store = new HealthEventStore({
			eventHistoryLimit: 20,
			latestBucketLimit: 1,
			staleAfterMs: 30_000,
		});
		const failedControlEvent = gatewayControlSessionEvent({
			observedAtMs: 1_000,
			result: 'failed',
		});
		store.record(failedControlEvent);

		for (const [index, reason] of (
			['caller_context_absent', 'caller_context_session_mismatch', 'caller_context_stale'] as const
		).entries()) {
			store.record({
				kind: 'caller-context-rejection',
				observedAtMs: 2_000 + index,
				operation: 'lease_renew',
				reason,
				result: 'failed',
				zoneId: 'beta',
			});
		}

		expect(store.listHistory()).toHaveLength(4);
		expect(store.listLatestEventsForZone('beta')).toEqual([failedControlEvent]);
		expect(store.deriveSnapshot({ nowMs: 3_000, zoneId: 'beta' })).toMatchObject({
			kind: 'failed',
			zoneId: 'beta',
		});
	});

	it('persists events to a durable log without making disk writes part of in-memory recording', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 10,
			staleAfterMs: 30_000,
		});
		const event = gatewayControlSessionEvent({ observedAtMs: 4_000 });

		store.record(event);
		await store.flushDurableWrites();

		expect(store.listHistory()).toEqual([event]);
		expect(append).toHaveBeenCalledWith(event);
	});

	it('keeps health recording available when durable log writes fail', async () => {
		const store = new HealthEventStore({
			durableEventLog: {
				append: vi.fn(async () => {
					throw new Error('disk full');
				}),
			},
			eventHistoryLimit: 10,
			staleAfterMs: 30_000,
		});
		const event = gatewayControlSessionEvent({ observedAtMs: 5_000, result: 'failed' });

		store.record(event);
		await expect(store.flushDurableWrites()).resolves.toBeUndefined();

		expect(store.listHistory()).toEqual([event]);
		expect(store.deriveSnapshot({ nowMs: 5_500, zoneId: 'beta' })).toMatchObject({
			kind: 'failed',
		});
	});

	it('fans events out to telemetry sinks without making sink writes part of health recording', async () => {
		const record = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			eventHistoryLimit: 10,
			healthEventSinks: [{ record }],
			staleAfterMs: 30_000,
		});
		const event = gatewayControlSessionEvent({ observedAtMs: 5_500 });

		store.record(event);

		expect(store.listHistory()).toEqual([event]);
		expect(record).not.toHaveBeenCalled();

		await store.flushHealthEventSinks();

		expect(record).toHaveBeenCalledWith(event);
	});

	it('keeps health recording available when telemetry sinks fail', async () => {
		const store = new HealthEventStore({
			eventHistoryLimit: 10,
			healthEventSinks: [
				{
					record: vi.fn(async () => {
						throw new Error('collector unavailable');
					}),
				},
			],
			staleAfterMs: 30_000,
		});
		const event = gatewayControlSessionEvent({ observedAtMs: 5_700, result: 'failed' });

		store.record(event);
		await expect(store.flushHealthEventSinks()).resolves.toBeUndefined();

		expect(store.listHistory()).toEqual([event]);
		expect(store.deriveSnapshot({ nowMs: 5_900, zoneId: 'beta' })).toMatchObject({
			kind: 'failed',
		});
	});

	it('continues draining subsequent telemetry after a sink rejection', async () => {
		const record = vi
			.fn<(event: AgentVmHealthEvent) => Promise<void>>()
			.mockRejectedValueOnce(new Error('collector unavailable'))
			.mockResolvedValue(undefined);
		const store = new HealthEventStore({
			eventHistoryLimit: 10,
			healthEventSinks: [{ record }],
			staleAfterMs: 30_000,
		});
		const firstEvent = gatewayControlSessionEvent({ observedAtMs: 5_800, result: 'failed' });
		const secondEvent = gatewayControlSessionEvent({
			observedAtMs: 5_801,
			operation: 'control-session-disconnect',
			result: 'failed',
		});

		store.record(firstEvent);
		store.record(secondEvent);
		await store.flushHealthEventSinks();

		expect(record).toHaveBeenNthCalledWith(1, firstEvent);
		expect(record).toHaveBeenNthCalledWith(2, secondEvent);
		expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
			failedOperations: 1,
			pendingRecords: 0,
		});
	});

	it('coalesces routine liveness evidence and sheds diagnostics at the fixed record capacity', async () => {
		const neverResolve = new Promise<void>(() => {});
		const record = vi.fn(async (_event: AgentVmHealthEvent) => await neverResolve);
		const store = new HealthEventStore({
			eventHistoryLimit: 20,
			evidenceQueueLimits: {
				flushTimeoutMs: 25,
				maxPendingBytes: 64_000,
				maxPendingRecords: 2,
				operationTimeoutMs: 50,
			},
			healthEventSinks: [{ record }],
			staleAfterMs: 30_000,
		});

		store.record(gatewayControlSessionEvent({ observedAtMs: 6_000 }));
		store.record(gatewayControlSessionEvent({ observedAtMs: 6_001 }));

		expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
			coalescedRecords: 1,
			pendingRecords: 1,
		});

		store.record(gatewayControlSessionEvent({ observedAtMs: 6_002, result: 'failed' }));
		store.record(
			gatewayControlSessionEvent({
				observedAtMs: 6_003,
				operation: 'control-session-disconnect',
				result: 'failed',
			}),
		);

		expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
			coalescedRecords: 1,
			droppedRecords: 1,
			maxPendingRecords: 2,
			pendingRecords: 2,
		});
		expect(store.listHistory()).toHaveLength(4);
		expect(store.deriveSnapshot({ nowMs: 6_004, zoneId: 'beta' })).toMatchObject({
			kind: 'failed',
		});
	});

	it('preferentially sheds caller-context diagnostics before failed authority evidence', async () => {
		vi.useFakeTimers();
		try {
			const neverResolve = new Promise<void>(() => {});
			const record = vi
				.fn<(event: AgentVmHealthEvent) => Promise<void>>()
				.mockImplementationOnce(async () => await neverResolve)
				.mockResolvedValue(undefined);
			const store = new HealthEventStore({
				eventHistoryLimit: 20,
				evidenceQueueLimits: {
					flushTimeoutMs: 25,
					maxOutstandingOperations: 2,
					maxPendingBytes: 64_000,
					maxPendingRecords: 2,
					operationTimeoutMs: 50,
				},
				healthEventSinks: [{ record }],
				staleAfterMs: 30_000,
			});
			const heldHeartbeat = gatewayControlSessionEvent({ observedAtMs: 6_050 });
			const failedAuthorityEvent = gatewayControlSessionEvent({
				observedAtMs: 6_051,
				operation: 'control-session-disconnect',
				result: 'failed',
			});
			const diagnosticEvents = (
				[
					'caller_context_absent',
					'caller_context_session_mismatch',
					'caller_context_stale',
				] as const
			).map(
				(reason, index) =>
					({
						kind: 'caller-context-rejection',
						observedAtMs: 6_052 + index,
						operation: index % 2 === 0 ? 'lease_renew' : 'lease_release',
						reason,
						result: 'failed',
						zoneId: 'beta',
					}) satisfies AgentVmHealthEvent,
			);

			store.record(heldHeartbeat);
			await Promise.resolve();
			await Promise.resolve();
			expect(record).toHaveBeenCalledWith(heldHeartbeat);

			store.record(failedAuthorityEvent);
			for (const diagnosticEvent of diagnosticEvents) {
				store.record(diagnosticEvent);
			}

			expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
				maxPendingRecords: 2,
				pendingRecords: 2,
			});

			await vi.advanceTimersByTimeAsync(50);
			await Promise.resolve();
			await Promise.resolve();

			expect(record).toHaveBeenCalledWith(failedAuthorityEvent);
			expect(
				record.mock.calls.filter(([event]) => event.kind === 'caller-context-rejection'),
			).toHaveLength(1);
			expect(
				store.getEvidenceQueueDiagnostics().healthEventSinks.pendingRecords,
			).toBeLessThanOrEqual(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('sheds evidence that exceeds the fixed byte capacity without blocking health mutation', () => {
		const store = new HealthEventStore({
			eventHistoryLimit: 10,
			evidenceQueueLimits: {
				flushTimeoutMs: 25,
				maxPendingBytes: 64,
				maxPendingRecords: 10,
				operationTimeoutMs: 50,
			},
			healthEventSinks: [{ record: vi.fn() }],
			staleAfterMs: 30_000,
		});
		const event = gatewayControlSessionEvent({ observedAtMs: 6_100, result: 'failed' });

		store.record(event);

		expect(store.listHistory()).toEqual([event]);
		expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
			droppedBytes: expect.any(Number),
			droppedRecords: 1,
			maxPendingBytes: 64,
			pendingBytes: 0,
			pendingRecords: 0,
		});
	});

	it('bounds a never-resolving sink to one active operation and keeps later product records available', async () => {
		vi.useFakeTimers();
		try {
			const neverResolve = new Promise<void>(() => {});
			const record = vi
				.fn<(event: AgentVmHealthEvent) => Promise<void>>()
				.mockImplementationOnce(async () => await neverResolve)
				.mockResolvedValue(undefined);
			const store = new HealthEventStore({
				eventHistoryLimit: 10,
				evidenceQueueLimits: {
					flushTimeoutMs: 25,
					maxPendingBytes: 64_000,
					maxPendingRecords: 2,
					operationTimeoutMs: 50,
				},
				healthEventSinks: [{ record }],
				staleAfterMs: 30_000,
			});

			store.record(gatewayControlSessionEvent({ observedAtMs: 6_200, result: 'failed' }));
			await Promise.resolve();
			await Promise.resolve();
			expect(record).toHaveBeenCalledTimes(1);

			let flushSettled = false;
			const flush = store.flushHealthEventSinks().then(() => {
				flushSettled = true;
			});
			await vi.advanceTimersByTimeAsync(24);
			expect(flushSettled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await flush;
			expect(flushSettled).toBe(true);

			const laterEvent = gatewayControlSessionEvent({
				observedAtMs: 6_201,
				result: 'failed',
			});
			store.record(laterEvent);

			expect(store.listHistory()).toEqual([
				gatewayControlSessionEvent({ observedAtMs: 6_200, result: 'failed' }),
				laterEvent,
			]);
			expect(store.deriveSnapshot({ nowMs: 6_202, zoneId: 'beta' })).toMatchObject({
				kind: 'failed',
			});
			expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
				flushTimeouts: 1,
				pendingRecords: 1,
			});
			await vi.advanceTimersByTimeAsync(25);
			expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
				activeOperations: 1,
				operationTimeouts: 1,
				pendingRecords: 0,
			});
			expect(record).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('bounds durable-log flush when the JSONL sink never resolves', async () => {
		vi.useFakeTimers();
		try {
			const neverResolve = new Promise<void>(() => {});
			const append = vi.fn(async (_event: AgentVmHealthEvent) => await neverResolve);
			const store = new HealthEventStore({
				durableEventLog: { append },
				eventHistoryLimit: 10,
				evidenceQueueLimits: {
					flushTimeoutMs: 20,
					maxPendingBytes: 64_000,
					maxPendingRecords: 2,
					operationTimeoutMs: 40,
				},
				staleAfterMs: 30_000,
			});

			store.record(gatewayControlSessionEvent({ observedAtMs: 6_300, result: 'failed' }));
			await Promise.resolve();
			await Promise.resolve();
			expect(append).toHaveBeenCalledTimes(1);

			const flush = store.flushDurableWrites();
			await vi.advanceTimersByTimeAsync(20);
			await flush;

			expect(store.getEvidenceQueueDiagnostics().durableLog).toMatchObject({
				flushTimeoutMs: 20,
				flushTimeouts: 1,
				maxPendingRecords: 2,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('aggregates spaced liveness heartbeats while delivering failure transitions promptly', async () => {
		vi.useFakeTimers();
		try {
			const record = vi.fn(async (_event: AgentVmHealthEvent) => {});
			const store = new HealthEventStore({
				eventHistoryLimit: 10,
				evidenceQueueLimits: {
					flushTimeoutMs: 25,
					livenessAggregationWindowMs: 100,
					maxOutstandingOperations: 2,
					maxPendingBytes: 64_000,
					maxPendingRecords: 10,
					operationTimeoutMs: 25,
				},
				healthEventSinks: [{ record }],
				staleAfterMs: 30_000,
			});
			const firstHeartbeat = gatewayControlSessionEvent({ observedAtMs: 6_400 });
			const latestHeartbeat = gatewayControlSessionEvent({ observedAtMs: 6_401 });
			const finalHeartbeat = gatewayControlSessionEvent({ observedAtMs: 6_402 });
			const disconnect = gatewayControlSessionEvent({
				observedAtMs: 6_403,
				operation: 'control-session-disconnect',
				result: 'failed',
			});

			store.record(firstHeartbeat);
			await Promise.resolve();
			await Promise.resolve();
			expect(record).toHaveBeenNthCalledWith(1, firstHeartbeat);
			await vi.advanceTimersByTimeAsync(50);
			store.record(latestHeartbeat);
			await Promise.resolve();
			expect(record).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(25);
			store.record(finalHeartbeat);
			await Promise.resolve();
			expect(record).toHaveBeenCalledTimes(1);

			store.record(disconnect);
			await Promise.resolve();
			await Promise.resolve();
			expect(record).toHaveBeenCalledTimes(2);
			expect(record).toHaveBeenNthCalledWith(2, disconnect);

			await vi.advanceTimersByTimeAsync(25);
			expect(record).toHaveBeenCalledTimes(3);
			expect(record).toHaveBeenNthCalledWith(3, finalHeartbeat);
			expect(store.getEvidenceQueueDiagnostics().healthEventSinks).toMatchObject({
				coalescedRecords: 1,
				highWaterPendingRecords: 2,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('updates live reconnect phase immediately while persisting one opening and one terminal summary', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const opening = reconnectEvent({});

		store.record(opening);
		await Promise.resolve();
		await Promise.resolve();
		expect(append).toHaveBeenCalledWith(opening);

		store.record(
			reconnectEvent({
				attemptCount: 1,
				latestObservedAtMs: 1_100,
				observedAtMs: 1_100,
				outcome: 'transport-error',
				reconnectPhase: 'attempt-failed',
			}),
		);
		store.record(
			reconnectEvent({
				attemptCount: 1,
				latestObservedAtMs: 1_110,
				nextRetryAtMs: 1_360,
				observedAtMs: 1_110,
				outcome: 'transport-error',
				reconnectPhase: 'retry-scheduled',
			}),
		);
		store.record(
			reconnectEvent({
				attemptCount: 2,
				latestObservedAtMs: 1_360,
				observedAtMs: 1_360,
				outcome: 'timeout',
				reconnectPhase: 'attempt-failed',
				result: 'timeout',
			}),
		);

		expect(store.listLatestEventsForZone('beta')).toEqual([
			reconnectEvent({
				attemptCount: 2,
				latestObservedAtMs: 1_360,
				observedAtMs: 1_360,
				outcome: 'timeout',
				reconnectPhase: 'attempt-failed',
				result: 'timeout',
			}),
		]);
		expect(append).toHaveBeenCalledTimes(1);

		const closed = reconnectEvent({
			attemptCount: 2,
			latestObservedAtMs: 1_500,
			observedAtMs: 1_500,
			outcome: 'accepted',
			reconnectPhase: 'accepted',
			result: 'ok',
			terminalReason: 'accepted',
			windowState: 'closed',
		});
		store.record(closed);
		await store.flushDurableWrites();

		expect(append).toHaveBeenCalledTimes(2);
		expect(append).toHaveBeenNthCalledWith(2, closed);
		expect(store.getEvidenceQueueDiagnostics().durableLog.coalescedRecords).toBe(3);
	});

	it('delivers a reconnect close that replaces a deferred outage update during normal draining', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const opening = reconnectEvent({});
		const deferredUpdate = reconnectEvent({
			attemptCount: 1,
			latestObservedAtMs: 1_100,
			observedAtMs: 1_100,
			outcome: 'transport-error',
			reconnectPhase: 'attempt-failed',
		});
		const closed = reconnectEvent({
			attemptCount: 1,
			latestObservedAtMs: 1_200,
			observedAtMs: 1_200,
			outcome: 'accepted',
			reconnectPhase: 'accepted',
			result: 'ok',
			terminalReason: 'accepted',
			windowState: 'closed',
		});

		store.record(opening);
		store.record(deferredUpdate);
		store.record(closed);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(append).toHaveBeenCalledTimes(2);
		expect(append).toHaveBeenNthCalledWith(1, opening);
		expect(append).toHaveBeenNthCalledWith(2, closed);
		expect(store.getEvidenceQueueDiagnostics().durableLog).toMatchObject({
			coalescedRecords: 1,
			pendingRecords: 0,
		});
	});

	it('waits for a timed-out reconnect opening delivery to settle before delivering its close', async () => {
		vi.useFakeTimers();
		try {
			const opening = reconnectEvent({});
			const closed = reconnectEvent({
				attemptCount: 1,
				latestObservedAtMs: 1_200,
				observedAtMs: 1_200,
				outcome: 'accepted',
				reconnectPhase: 'accepted',
				result: 'ok',
				terminalReason: 'accepted',
				windowState: 'closed',
			});
			let resolveOpeningDelivery: (() => void) | undefined;
			const openingDelivery = new Promise<void>((resolve) => {
				resolveOpeningDelivery = resolve;
			});
			const append = vi.fn(async (event: AgentVmHealthEvent) => {
				if (event === opening) {
					await openingDelivery;
				}
			});
			const store = new HealthEventStore({
				durableEventLog: { append },
				eventHistoryLimit: 20,
				evidenceQueueLimits: {
					maxOutstandingOperations: 2,
					operationTimeoutMs: 20,
				},
				staleAfterMs: 30_000,
			});

			store.record(opening);
			await Promise.resolve();
			await Promise.resolve();
			expect(append).toHaveBeenCalledTimes(1);
			expect(append).toHaveBeenNthCalledWith(1, opening);

			store.record(
				reconnectEvent({
					attemptCount: 1,
					latestObservedAtMs: 1_100,
					observedAtMs: 1_100,
					outcome: 'transport-error',
					reconnectPhase: 'attempt-failed',
				}),
			);
			store.record(closed);
			await vi.advanceTimersByTimeAsync(20);

			expect(append).toHaveBeenCalledTimes(1);
			expect(store.getEvidenceQueueDiagnostics().durableLog).toMatchObject({
				activeOperations: 1,
				operationTimeouts: 1,
				pendingRecords: 1,
			});

			resolveOpeningDelivery?.();
			await vi.advanceTimersByTimeAsync(0);

			expect(append).toHaveBeenCalledTimes(2);
			expect(append).toHaveBeenNthCalledWith(1, opening);
			expect(append).toHaveBeenNthCalledWith(2, closed);
			expect(store.getEvidenceQueueDiagnostics().durableLog).toMatchObject({
				activeOperations: 0,
				pendingRecords: 0,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('retains reconnect opening and close evidence under routine and intermediate capacity pressure', async () => {
		const opening = reconnectEvent({});
		const closed = reconnectEvent({
			attemptCount: 2,
			latestObservedAtMs: 1_300,
			observedAtMs: 1_300,
			outcome: 'accepted',
			reconnectPhase: 'accepted',
			result: 'ok',
			terminalReason: 'accepted',
			windowState: 'closed',
		});
		const pairByteSize =
			Buffer.byteLength(JSON.stringify(opening), 'utf8') +
			Buffer.byteLength(JSON.stringify(closed), 'utf8');
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 20,
			evidenceQueueLimits: {
				maxPendingBytes: pairByteSize,
				maxPendingRecords: 2,
			},
			staleAfterMs: 30_000,
		});

		store.record(opening);
		for (let attemptCount = 1; attemptCount <= 2; attemptCount += 1) {
			store.record(
				reconnectEvent({
					attemptCount,
					latestObservedAtMs: 1_000 + attemptCount,
					observedAtMs: 1_000 + attemptCount,
					outcome: 'transport-error',
					reconnectPhase: 'attempt-failed',
				}),
			);
		}
		store.record(gatewayControlSessionEvent({ observedAtMs: 1_100 }));
		store.record(gatewayControlSessionEvent({ observedAtMs: 1_101 }));
		store.record(closed);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(append).toHaveBeenCalledTimes(2);
		expect(append).toHaveBeenNthCalledWith(1, opening);
		expect(append).toHaveBeenNthCalledWith(2, closed);
		const diagnostics = store.getEvidenceQueueDiagnostics().durableLog;
		expect(diagnostics).toMatchObject({
			maxPendingBytes: pairByteSize,
			maxPendingRecords: 2,
			pendingBytes: 0,
			pendingRecords: 0,
		});
		expect(diagnostics.droppedRecords).toBeGreaterThan(0);
	});

	it('does not coalesce reconnect windows from different exact Gateway sources', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});

		store.record(reconnectEvent({ bootId: 'gateway-boot-a' }));
		store.record(
			reconnectEvent({
				bootId: 'gateway-boot-b',
				peerId: 'gateway-beta-successor',
			}),
		);
		await store.flushDurableWrites();

		expect(append).toHaveBeenCalledTimes(2);
	});

	it('bounds sink flushes when reconnect close evidence is missing or delayed', async () => {
		vi.useFakeTimers();
		try {
			const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
			const record = vi.fn(async (_event: AgentVmHealthEvent) => {});
			const store = new HealthEventStore({
				durableEventLog: { append },
				eventHistoryLimit: 20,
				evidenceQueueLimits: {
					flushTimeoutMs: 20,
					operationTimeoutMs: 20,
				},
				healthEventSinks: [{ record }],
				staleAfterMs: 30_000,
			});

			store.record(reconnectEvent({}));
			await Promise.resolve();
			await Promise.resolve();
			expect(append).toHaveBeenCalledTimes(1);
			expect(record).toHaveBeenCalledTimes(1);

			store.record(
				reconnectEvent({
					attemptCount: 1,
					latestObservedAtMs: 1_100,
					observedAtMs: 1_100,
					outcome: 'transport-error',
					reconnectPhase: 'attempt-failed',
				}),
			);
			let flushesSettled = false;
			const flushes = Promise.all([store.flushDurableWrites(), store.flushHealthEventSinks()]).then(
				() => {
					flushesSettled = true;
				},
			);

			await vi.advanceTimersByTimeAsync(19);
			expect(flushesSettled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await flushes;

			expect(flushesSettled).toBe(true);
			expect(append).toHaveBeenCalledTimes(1);
			expect(record).toHaveBeenCalledTimes(1);
			expect(store.getEvidenceQueueDiagnostics()).toMatchObject({
				durableLog: { flushTimeouts: 1, pendingRecords: 1 },
				healthEventSinks: { flushTimeouts: 1, pendingRecords: 1 },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('persists a stale-source terminal summary without overwriting current live state', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const currentAccepted = reconnectEvent({
			bootId: 'gateway-boot-current',
			latestObservedAtMs: 2_000,
			observedAtMs: 2_000,
			outcome: 'accepted',
			peerId: 'gateway-current',
			reconnectPhase: 'accepted',
			result: 'ok',
			terminalReason: 'accepted',
			windowState: 'closed',
		});
		const staleDisposed = reconnectEvent({
			bootId: 'gateway-boot-stale',
			latestObservedAtMs: 2_100,
			observedAtMs: 2_100,
			peerId: 'gateway-stale',
			reconnectPhase: 'retry-scheduled',
			terminalReason: 'gateway-superseded',
			windowState: 'closed',
		});

		store.record(currentAccepted);
		store.recordEvidenceOnly(staleDisposed);
		await store.flushDurableWrites();

		expect(store.listLatestEventsForZone('beta')).toEqual([currentAccepted]);
		expect(store.listHistory()).toEqual([currentAccepted]);
		expect(append).toHaveBeenCalledWith(staleDisposed);
	});

	it('persists recovery action and failure class through the durable log boundary', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 10,
			staleAfterMs: 30_000,
		});
		const event = {
			action: 'operator-required',
			consecutiveFailures: 3,
			cooldownMs: 3_660_000,
			elapsedMs: 25,
			errorCode: 'owner-unsafe',
			kind: 'gateway-recovery',
			observedAtMs: 6_000,
			reason: 'gateway-service-unhealthy',
			result: 'failed',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		store.record(event);
		await store.flushDurableWrites();

		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'operator-required',
				errorCode: 'owner-unsafe',
				kind: 'gateway-recovery',
			}),
		);
	});

	it('persists failed Tool VM SSH lease events through the durable log boundary', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 10,
			staleAfterMs: 30_000,
		});
		const event = {
			agentId: 'main',
			elapsedMs: 5_000,
			errorCode: 'ssh-command-failed',
			kind: 'tool-vm-ssh',
			leaseId: 'lease-a',
			observedAtMs: 7_000,
			operation: 'command',
			result: 'failed',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		store.record(event);
		await store.flushDurableWrites();

		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({
				errorCode: 'ssh-command-failed',
				kind: 'tool-vm-ssh',
				leaseId: 'lease-a',
				result: 'failed',
			}),
		);
	});

	it('persists May 30-shaped channel-provider events without folding in secret blockers', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 10,
			staleAfterMs: 30_000,
		});
		const channelProviderEvent = {
			channelProviderId: 'primary-channel',
			details: { closeCode: 1006, providerType: 'discord', reconnecting: true },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 8_000,
			result: 'failed',
			unhealthySinceMs: 8_000,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		const secretRecoveryEvent = {
			action: 'observe-only',
			consecutiveFailures: 3,
			cooldownMs: 3_660_000,
			elapsedMs: 25,
			errorCode: 'secret-resolution-failed',
			kind: 'gateway-recovery',
			observedAtMs: 9_000,
			reason: 'agent-channel-provider-unhealthy',
			result: 'failed',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		store.record(channelProviderEvent);
		store.record(secretRecoveryEvent);
		await store.flushDurableWrites();

		expect(append).toHaveBeenNthCalledWith(1, channelProviderEvent);
		expect(append).toHaveBeenNthCalledWith(2, secretRecoveryEvent);
		expect(store.deriveSnapshot({ nowMs: 9_500, zoneId: 'beta' })).toMatchObject({
			issues: expect.arrayContaining([
				expect.objectContaining({
					kind: 'agent-channel-provider-unhealthy',
					latestEvent: expect.objectContaining({
						details: { closeCode: 1006, providerType: 'discord', reconnecting: true },
					}),
				}),
				expect.objectContaining({
					kind: 'gateway-recovery-failed',
					latestEvent: expect.objectContaining({
						errorCode: 'secret-resolution-failed',
					}),
				}),
			]),
			kind: 'failed',
		});
	});
});
