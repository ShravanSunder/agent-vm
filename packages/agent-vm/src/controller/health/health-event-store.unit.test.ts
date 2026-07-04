import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
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
