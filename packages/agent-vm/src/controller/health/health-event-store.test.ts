import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it } from 'vitest';

import { HealthEventStore } from './health-event-store.js';

function gatewayControlLinkEvent(overrides: Partial<AgentVmHealthEvent> = {}): AgentVmHealthEvent {
	return {
		controllerHost: 'controller.vm.host',
		controllerPort: 18800,
		elapsedMs: 12,
		kind: 'gateway-control-link',
		observedAtMs: 1_000,
		operation: 'controller-health',
		path: '/health',
		result: 'ok',
		zoneId: 'beta',
		...overrides,
	} as AgentVmHealthEvent;
}

describe('HealthEventStore', () => {
	it('keeps the latest event per zone and health bucket', () => {
		const store = new HealthEventStore({ eventHistoryLimit: 10, staleAfterMs: 30_000 });

		store.record(gatewayControlLinkEvent({ observedAtMs: 1_000, result: 'failed' }));
		store.record(gatewayControlLinkEvent({ observedAtMs: 2_000, result: 'ok' }));

		expect(store.listLatestEventsForZone('beta')).toEqual([
			gatewayControlLinkEvent({ observedAtMs: 2_000, result: 'ok' }),
		]);
		expect(store.deriveSnapshot({ nowMs: 3_000, zoneId: 'beta' })).toMatchObject({
			kind: 'ok',
			zoneId: 'beta',
		});
	});

	it('bounds retained event history independently from latest state', () => {
		const store = new HealthEventStore({ eventHistoryLimit: 2, staleAfterMs: 30_000 });

		store.record(gatewayControlLinkEvent({ observedAtMs: 1_000 }));
		store.record(
			gatewayControlLinkEvent({
				kind: 'gateway-service-health',
				observedAtMs: 2_000,
				path: '/health',
				port: 18789,
				statusCode: 200,
			}),
		);
		store.record(
			gatewayControlLinkEvent({
				gatewayService: 'openclaw',
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
});
