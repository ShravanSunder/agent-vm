import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

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

	it('persists events to a durable log without making disk writes part of in-memory recording', async () => {
		const append = vi.fn(async (_event: AgentVmHealthEvent) => {});
		const store = new HealthEventStore({
			durableEventLog: { append },
			eventHistoryLimit: 10,
			staleAfterMs: 30_000,
		});
		const event = gatewayControlLinkEvent({ observedAtMs: 4_000 });

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
		const event = gatewayControlLinkEvent({ observedAtMs: 5_000, result: 'failed' });

		store.record(event);
		await expect(store.flushDurableWrites()).resolves.toBeUndefined();

		expect(store.listHistory()).toEqual([event]);
		expect(store.deriveSnapshot({ nowMs: 5_500, zoneId: 'beta' })).toMatchObject({
			kind: 'failed',
		});
	});

	it('logs durable write failures with rate limiting while keeping health recording available', async () => {
		let nowMs = 1_000;
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const storeOptions = {
			durableEventLog: {
				append: vi.fn(async () => {
					throw new Error('disk full');
				}),
			},
			eventHistoryLimit: 10,
			now: () => nowMs,
			staleAfterMs: 30_000,
		} satisfies ConstructorParameters<typeof HealthEventStore>[0] & {
			readonly now: () => number;
		};
		const store = new HealthEventStore(storeOptions);

		try {
			store.record(gatewayControlLinkEvent({ observedAtMs: 5_000, result: 'failed' }));
			store.record(gatewayControlLinkEvent({ observedAtMs: 5_001, result: 'failed' }));
			await store.flushDurableWrites();

			expect(
				stderrWrite.mock.calls.filter(([message]) =>
					String(message).includes('durable health event log append failed'),
				),
			).toHaveLength(1);
			expect(stderrWrite.mock.calls.join('\n')).toContain('disk full');

			nowMs += 59_000;
			store.record(gatewayControlLinkEvent({ observedAtMs: 5_002, result: 'failed' }));
			await store.flushDurableWrites();
			expect(
				stderrWrite.mock.calls.filter(([message]) =>
					String(message).includes('durable health event log append failed'),
				),
			).toHaveLength(1);

			nowMs += 1_000;
			store.record(gatewayControlLinkEvent({ observedAtMs: 5_003, result: 'failed' }));
			await store.flushDurableWrites();
			expect(
				stderrWrite.mock.calls.filter(([message]) =>
					String(message).includes('durable health event log append failed'),
				),
			).toHaveLength(2);

			expect(store.deriveSnapshot({ nowMs: 5_500, zoneId: 'beta' })).toMatchObject({
				kind: 'failed',
			});
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('logs a new durable write failure streak after a successful append', async () => {
		let nowMs = 1_000;
		let appendShouldFail = true;
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const store = new HealthEventStore({
			durableEventLog: {
				append: vi.fn(async () => {
					if (appendShouldFail) {
						throw new Error('disk full');
					}
				}),
			},
			eventHistoryLimit: 10,
			now: () => nowMs,
			staleAfterMs: 30_000,
		});

		try {
			store.record(gatewayControlLinkEvent({ observedAtMs: 5_000, result: 'failed' }));
			await store.flushDurableWrites();
			expect(
				stderrWrite.mock.calls.filter(([message]) =>
					String(message).includes('durable health event log append failed'),
				),
			).toHaveLength(1);

			appendShouldFail = false;
			nowMs += 1_000;
			store.record(gatewayControlLinkEvent({ observedAtMs: 5_001, result: 'ok' }));
			await store.flushDurableWrites();

			appendShouldFail = true;
			nowMs += 1_000;
			store.record(gatewayControlLinkEvent({ observedAtMs: 5_002, result: 'failed' }));
			await store.flushDurableWrites();

			expect(
				stderrWrite.mock.calls.filter(([message]) =>
					String(message).includes('durable health event log append failed'),
				),
			).toHaveLength(2);
		} finally {
			stderrWrite.mockRestore();
		}
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
