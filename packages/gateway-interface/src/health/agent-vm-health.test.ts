import { describe, expect, it } from 'vitest';

import {
	deriveZoneHealthSnapshot,
	healthEventBucketKey,
	isAgentVmHealthEvent,
	type AgentVmHealthEvent,
} from './agent-vm-health.js';

describe('agent-vm health events', () => {
	it('accepts zone-scoped gateway control-link events with controller endpoint literals', () => {
		const event = {
			controllerHost: 'controller.vm.host',
			controllerPort: 18800,
			elapsedMs: 12,
			kind: 'gateway-control-link',
			observedAtMs: 1_000,
			operation: 'controller-health',
			path: '/health',
			result: 'ok',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(
			isAgentVmHealthEvent({
				...event,
				controllerHost: 'wrong.vm.host',
			}),
		).toBe(false);
	});

	it('keeps gateway plugin health generic over gateway type', () => {
		const workerEvent = {
			gatewayService: 'worker',
			kind: 'gateway-plugin-health',
			observedAtMs: 2_000,
			result: 'ok',
			state: 'ready',
			zoneId: 'worker-zone',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(workerEvent)).toBe(true);
	});

	it('accepts gateway recovery health events', () => {
		const event = {
			action: 'gateway-vm-restart',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			kind: 'gateway-recovery',
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			observedAtMs: 1_000,
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			reason: 'gateway-control-link-unhealthy',
			result: 'ok',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe('sunfam:gateway-recovery:gateway-vm-restart');
	});

	it('surfaces failed gateway recovery as a zone health issue', () => {
		const event = {
			action: 'gateway-vm-restart',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			errorCode: 'restart-verification-failed',
			kind: 'gateway-recovery',
			observedAtMs: 1_000,
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			reason: 'gateway-service-unhealthy',
			result: 'failed',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		const snapshot = deriveZoneHealthSnapshot([event], {
			nowMs: 2_000,
			staleAfterMs: 30_000,
			zoneId: 'sunfam',
		});

		expect(snapshot.kind).toBe('failed');
		if (snapshot.kind !== 'failed') {
			throw new Error('Expected failed snapshot.');
		}
		expect(snapshot.issues[0]?.kind).toBe('gateway-recovery-failed');
	});

	it('accepts suspended gateway recovery events and surfaces them as distinct issues', () => {
		const event = {
			action: 'gateway-vm-restart',
			consecutiveFailedRecoveries: 3,
			consecutiveFailures: 12,
			cooldownMs: 3_660_000,
			errorCode: 'max-failed-recoveries',
			failedRecoveryResetMs: 86_400_000,
			kind: 'gateway-recovery-suspended',
			observedAtMs: 1_000,
			reason: 'gateway-service-unhealthy',
			result: 'failed',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe(
			'sunfam:gateway-recovery-suspended:gateway-vm-restart',
		);

		const snapshot = deriveZoneHealthSnapshot([event], {
			nowMs: 2_000,
			staleAfterMs: 30_000,
			zoneId: 'sunfam',
		});

		expect(snapshot.kind).toBe('failed');
		if (snapshot.kind !== 'failed') {
			throw new Error('Expected failed snapshot.');
		}
		expect(snapshot.issues[0]?.kind).toBe('gateway-recovery-suspended');
	});

	it('rejects ISO observedAt strings because stale math uses observedAtMs', () => {
		expect(
			isAgentVmHealthEvent({
				kind: 'gateway-service-health',
				observedAt: '2026-05-26T00:00:00.000Z',
				path: '/readyz',
				port: 18789,
				result: 'ok',
				zoneId: 'beta',
			}),
		).toBe(false);
	});

	it('derives unknown, ok, failed, and stale zone snapshots', () => {
		expect(
			deriveZoneHealthSnapshot([], {
				nowMs: 10_000,
				staleAfterMs: 30_000,
				zoneId: 'beta',
			}),
		).toEqual({ kind: 'unknown', reason: 'no-events', zoneId: 'beta' });

		const okEvent = {
			kind: 'gateway-service-health',
			observedAtMs: 9_000,
			path: '/health',
			port: 18789,
			result: 'ok',
			statusCode: 200,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		expect(
			deriveZoneHealthSnapshot([okEvent], {
				nowMs: 10_000,
				staleAfterMs: 30_000,
				zoneId: 'beta',
			}).kind,
		).toBe('ok');

		const failedEvent = {
			...okEvent,
			result: 'failed',
			statusCode: 503,
		} satisfies AgentVmHealthEvent;
		const failedSnapshot = deriveZoneHealthSnapshot([failedEvent], {
			nowMs: 10_000,
			staleAfterMs: 30_000,
			zoneId: 'beta',
		});
		expect(failedSnapshot.kind).toBe('failed');
		if (failedSnapshot.kind !== 'failed') {
			throw new Error('expected failed snapshot');
		}
		expect(failedSnapshot.issues[0]?.kind).toBe('gateway-service-unhealthy');

		const staleSnapshot = deriveZoneHealthSnapshot([okEvent], {
			nowMs: 50_000,
			staleAfterMs: 30_000,
			zoneId: 'beta',
		});
		expect(staleSnapshot.kind).toBe('stale');
		if (staleSnapshot.kind !== 'stale') {
			throw new Error('expected stale snapshot');
		}
		expect(staleSnapshot.issues[0]?.kind).toBe('health-event-stale');
	});

	it('does not double-record rich lease operations as generic controller requests', () => {
		expect(
			isAgentVmHealthEvent({
				attempt: 1,
				elapsedMs: 5,
				kind: 'controller-request',
				maxAttempts: 1,
				observedAtMs: 1_000,
				operation: 'lease-heartbeat',
				result: 'ok',
				zoneId: 'beta',
			}),
		).toBe(false);
	});

	it('keeps different lease heartbeat buckets visible in the zone snapshot', () => {
		const failedLeaseHeartbeat = {
			agentId: 'agent-a',
			elapsedMs: 5_000,
			errorCode: 'controller-request-timeout',
			kind: 'lease-heartbeat',
			leaseId: 'lease-a',
			observedAtMs: 1_000,
			result: 'timeout',
			useId: 'use-a',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		const okLeaseHeartbeat = {
			agentId: 'agent-b',
			elapsedMs: 12,
			kind: 'lease-heartbeat',
			leaseId: 'lease-b',
			observedAtMs: 2_000,
			result: 'ok',
			useId: 'use-b',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		const snapshot = deriveZoneHealthSnapshot([failedLeaseHeartbeat, okLeaseHeartbeat], {
			nowMs: 3_000,
			staleAfterMs: 30_000,
			zoneId: 'beta',
		});

		expect(snapshot.kind).toBe('failed');
		if (snapshot.kind !== 'failed') {
			throw new Error('expected failed snapshot');
		}
		expect(snapshot.latestEvents).toHaveLength(2);
		expect(snapshot.issues).toHaveLength(1);
		expect(snapshot.issues[0]?.latestEvent).toEqual(failedLeaseHeartbeat);
	});
});
