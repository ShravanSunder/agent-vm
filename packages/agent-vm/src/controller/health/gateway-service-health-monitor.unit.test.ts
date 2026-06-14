import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayServiceHealthMonitor,
	type GatewayVmRecoveryResult,
} from './gateway-service-health-monitor.js';
import { HealthEventStore } from './health-event-store.js';

/* oxlint-disable eslint/no-await-in-loop -- Consecutive monitor ticks are intentionally sequential state transitions. */

const gatewayServiceAutoRestart = {
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: true,
	failedRecoveryResetMs: 24 * 60 * 60 * 1000,
	maxConsecutiveFailedRecoveries: 3,
	restartTimeoutMs: 10 * 60 * 1000,
} as const;

class MutableLatestHealthEventStore extends HealthEventStore {
	#latestEventsByZoneId = new Map<string, readonly AgentVmHealthEvent[]>();

	constructor() {
		super({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
	}

	override listLatestEventsForZone(zoneId: string): readonly AgentVmHealthEvent[] {
		return this.#latestEventsByZoneId.get(zoneId) ?? [];
	}

	override record(_event: AgentVmHealthEvent): void {}

	setLatestEvents(zoneId: string, events: readonly AgentVmHealthEvent[]): void {
		this.#latestEventsByZoneId.set(zoneId, events);
	}
}

describe('createGatewayServiceHealthMonitor', () => {
	it('records ok and failed gateway service probes', async () => {
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const probeZoneHealth = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'beta',
			})
			.mockResolvedValueOnce({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 503,
				zoneId: 'sunfam',
			});
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart,
			healthEventStore,
			intervalMs: 10_000,
			now: () => 12_000,
			probeZoneHealth,
			staleAfterMs: 30_000,
			zoneIds: ['beta', 'sunfam'],
		});

		await monitor.tick();

		expect(healthEventStore.listLatestEventsForZone('beta')).toEqual([
			expect.objectContaining({
				kind: 'gateway-service-health',
				result: 'ok',
				statusCode: 200,
				zoneId: 'beta',
			}),
		]);
		expect(healthEventStore.listLatestEventsForZone('sunfam')).toEqual([
			expect.objectContaining({
				kind: 'gateway-service-health',
				result: 'failed',
				statusCode: 503,
				zoneId: 'sunfam',
			}),
		]);
	});

	it('records failed gateway service health when a probe throws', async () => {
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart,
			healthEventStore,
			intervalMs: 10_000,
			now: () => 12_000,
			probeZoneHealth: vi.fn(async () => {
				throw new Error('gateway vm exec failed');
			}),
			staleAfterMs: 30_000,
			zoneIds: ['beta'],
		});

		await monitor.tick();

		expect(healthEventStore.listLatestEventsForZone('beta')).toEqual([
			expect.objectContaining({
				kind: 'gateway-service-health',
				path: '(unknown)',
				port: 0,
				result: 'failed',
				zoneId: 'beta',
			}),
		]);
	});

	it('stops the scheduled monitor timer', async () => {
		const clearIntervalImpl = vi.fn();
		const unref = vi.fn();
		const timer = { unref } as unknown as NodeJS.Timeout;
		const setIntervalImpl = vi.fn(() => timer);
		const monitor = createGatewayServiceHealthMonitor({
			clearIntervalImpl,
			gatewayServiceAutoRestart,
			healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
			intervalMs: 10_000,
			now: () => 12_000,
			probeZoneHealth: vi.fn(),
			setIntervalImpl,
			staleAfterMs: 30_000,
			zoneIds: ['beta'],
		});

		monitor.start();
		await monitor.stop();

		expect(setIntervalImpl).toHaveBeenCalledOnce();
		expect(clearIntervalImpl).toHaveBeenCalledWith(timer);
		expect(unref).toHaveBeenCalledOnce();
	});

	it('restarts a gateway VM after 10 consecutive failed gateway service probes', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			operationId: 'sunfam-restart-018f',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart,
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		for (let index = 1; index <= 9; index += 1) {
			nowMs = index * 10_000;
			await monitor.tick();
		}
		expect(recoverGatewayVm).not.toHaveBeenCalled();

		nowMs = 100_000;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledOnce();
		expect(recoverGatewayVm).toHaveBeenCalledWith({
			consecutiveFailures: 10,
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});
		expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
			expect.objectContaining({
				kind: 'gateway-recovery',
				leaseReleaseFailureCount: 0,
				newVmId: 'new-gateway-vm',
				oldVmId: 'old-gateway-vm',
				operationId: 'sunfam-restart-018f',
				result: 'ok',
				zoneId: 'sunfam',
			}),
		);
	});

	it('restarts a gateway VM after 10 consecutive stale gateway control-link observations', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			controllerHost: 'controller.vm.host',
			controllerPort: 18800,
			elapsedMs: 1,
			kind: 'gateway-control-link',
			observedAtMs: 1_000,
			operation: 'controller-health',
			path: '/health',
			result: 'ok',
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart,
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		for (let index = 1; index <= 9; index += 1) {
			nowMs = 40_000 + index * 10_000;
			await monitor.tick();
		}
		expect(recoverGatewayVm).not.toHaveBeenCalled();

		nowMs = 140_000;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledOnce();
		expect(recoverGatewayVm).toHaveBeenCalledWith({
			consecutiveFailures: 10,
			reason: 'gateway-control-link-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('does not restart when unrelated controller-request failures accumulate while gateway service and control link are healthy', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 50,
			staleAfterMs: 30_000,
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart,
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		for (let index = 1; index <= 13; index += 1) {
			nowMs = index * 10_000;
			healthEventStore.record({
				attempt: index,
				elapsedMs: 100,
				errorCode: 'channel-provider-disconnected',
				kind: 'controller-request',
				maxAttempts: 1,
				observedAtMs: nowMs,
				operation: 'openclaw-runtime-status',
				result: 'failed',
				zoneId: 'sunfam',
			});
			healthEventStore.record({
				controllerHost: 'controller.vm.host',
				controllerPort: 18800,
				elapsedMs: 1,
				kind: 'gateway-control-link',
				observedAtMs: nowMs,
				operation: 'controller-health',
				path: '/health',
				result: 'ok',
				zoneId: 'sunfam',
			});
			await monitor.tick();
		}

		expect(recoverGatewayVm).not.toHaveBeenCalled();
	});

	it('recovers when a generic channel provider is unhealthy recoverable while gateway service is healthy', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			details: { closeCode: 1006, providerType: 'discord' },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'failed',
			unhealthySinceMs: 1_000,
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			classifyRecoveryBudgetClass: () => 'gateway-vm-cold-start',
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 3,
				channelProviderHealth: {
					enabled: true,
					consecutiveFailureThreshold: 3,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();
		expect(recoverGatewayVm).not.toHaveBeenCalled();
		nowMs = 20_000;
		await monitor.tick();
		expect(recoverGatewayVm).not.toHaveBeenCalled();
		nowMs = 30_000;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledWith({
			consecutiveFailures: 3,
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('evicts recovered channel-provider event keys instead of growing forever', async () => {
		let nowMs = 0;
		const healthEventStore = new MutableLatestHealthEventStore();
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 1,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				channelProviderHealth: {
					consecutiveFailureThreshold: 1,
					enabled: true,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
				consecutiveFailureThreshold: 1,
				cooldownMs: 0,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 100_000,
			zoneIds: ['sunfam'],
		});
		const recoveredEventCount = 50_000;
		let firstRecoveredEvent: AgentVmHealthEvent | undefined;

		for (let index = 0; index < recoveredEventCount; index += 1) {
			nowMs = 10_000 + index;
			const channelProviderEvent = {
				channelProviderId: `provider-${String(index)}`,
				details: { providerType: 'discord' },
				health: 'unhealthy-recoverable',
				kind: 'agent-channel-provider-health',
				observedAtMs: nowMs,
				result: 'failed',
				unhealthySinceMs: nowMs,
				zoneId: 'sunfam',
			} satisfies AgentVmHealthEvent;
			firstRecoveredEvent ??= channelProviderEvent;
			healthEventStore.setLatestEvents('sunfam', [channelProviderEvent]);
			await monitor.tick();
		}
		expect(firstRecoveredEvent).toBeDefined();
		expect(recoverGatewayVm).toHaveBeenCalledTimes(recoveredEventCount);

		if (firstRecoveredEvent === undefined) {
			throw new Error('expected at least one recovered channel-provider event');
		}
		const lastEvictedEvent = {
			channelProviderId: 'provider-39999',
			details: { providerType: 'discord' },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 49_999,
			result: 'failed',
			unhealthySinceMs: 49_999,
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;
		const firstRetainedEvent = {
			channelProviderId: 'provider-40000',
			details: { providerType: 'discord' },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 50_000,
			result: 'failed',
			unhealthySinceMs: 50_000,
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;
		nowMs += 100_001;
		healthEventStore.setLatestEvents('sunfam', [firstRetainedEvent]);
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(recoveredEventCount);

		healthEventStore.setLatestEvents('sunfam', [lastEvictedEvent]);
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(recoveredEventCount + 1);
	});

	it('does not let one zone evict another zone recovered channel-provider key', async () => {
		let nowMs = 0;
		const healthEventStore = new MutableLatestHealthEventStore();
		const recoveredZoneIds: string[] = [];
		const recoverGatewayVm = vi.fn(async (request: { readonly zoneId: string }) => {
			recoveredZoneIds.push(request.zoneId);
			return {
				elapsedMs: 1,
				leaseReleaseFailureCount: 0,
				newBootedAt: '2026-05-27T13:01:00.000Z',
				newHostPid: 2222,
				newVmId: 'new-gateway-vm',
				oldBootedAt: '2026-05-27T12:00:00.000Z',
				oldHostPid: 1111,
				oldVmId: 'old-gateway-vm',
				result: 'ok' as const,
			};
		});
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				channelProviderHealth: {
					consecutiveFailureThreshold: 1,
					enabled: true,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
				consecutiveFailureThreshold: 1,
				cooldownMs: 0,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async (zoneId: string) => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId,
			})),
			recoverGatewayVm,
			staleAfterMs: 100_000,
			zoneIds: ['victim-zone', 'attacker-zone'],
		});
		const victimEvent = {
			channelProviderId: 'victim-provider',
			details: { providerType: 'discord' },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 10_000,
			result: 'failed',
			unhealthySinceMs: 10_000,
			zoneId: 'victim-zone',
		} satisfies AgentVmHealthEvent;

		nowMs = 10_000;
		healthEventStore.setLatestEvents('victim-zone', [victimEvent]);
		healthEventStore.setLatestEvents('attacker-zone', []);
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(1);
		expect(recoverGatewayVm).toHaveBeenLastCalledWith({
			consecutiveFailures: 1,
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'victim-zone',
		});

		for (let index = 0; index < 10_001; index += 1) {
			nowMs = 20_000 + index;
			healthEventStore.setLatestEvents('attacker-zone', [
				{
					channelProviderId: `attacker-provider-${String(index)}`,
					details: { providerType: 'discord' },
					health: 'unhealthy-recoverable',
					kind: 'agent-channel-provider-health',
					observedAtMs: nowMs,
					result: 'failed',
					unhealthySinceMs: nowMs,
					zoneId: 'attacker-zone',
				} satisfies AgentVmHealthEvent,
			]);
			await monitor.tick();
		}

		expect(recoveredZoneIds.filter((zoneId) => zoneId === 'victim-zone')).toHaveLength(1);
	});

	it('does not restart for a recoverable channel provider by default while gateway service is healthy', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			details: { closeCode: 1006, providerType: 'discord' },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'failed',
			unhealthySinceMs: 1_000,
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async (): Promise<GatewayVmRecoveryResult> => {
			throw new Error('recoverGatewayVm should not run for default channel-provider policy');
		});
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart,
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		for (let tickIndex = 1; tickIndex <= 3; tickIndex += 1) {
			nowMs = tickIndex * 10_000;
			await monitor.tick();
		}

		expect(recoverGatewayVm).not.toHaveBeenCalled();
		expect(healthEventStore.listLatestEventsForZone('sunfam')).not.toContainEqual(
			expect.objectContaining({
				kind: 'gateway-recovery',
			}),
		);
	});

	it('recovers from stale unhealthy channel-provider evidence while gateway service is healthy', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			details: { closeCode: 1006, providerType: 'discord' },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'failed',
			unhealthySinceMs: 1_000,
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				channelProviderHealth: {
					enabled: true,
					consecutiveFailureThreshold: 1,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 31_001;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledWith({
			consecutiveFailures: 1,
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('recovers when the latest healthy channel-provider event becomes stale while gateway service is healthy', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			health: 'healthy',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'ok',
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				channelProviderHealth: {
					enabled: true,
					consecutiveFailureThreshold: 1,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 31_001;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledWith({
			consecutiveFailures: 1,
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('does not recover again from the same stale transitioning channel provider event after a successful recovery', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			health: 'transitioning',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'ok',
			transitionStartedAtMs: 1_000,
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			action: 'gateway-vm-restart' as const,
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				channelProviderHealth: {
					enabled: true,
					consecutiveFailureThreshold: 1,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 200_000;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledOnce();
	});

	it('does not restart for an unrecoverable channel provider by default while gateway service is healthy', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			health: 'unhealthy-unrecoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'failed',
			unhealthySinceMs: 1_000,
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				channelProviderHealth: {
					enabled: true,
					consecutiveFailureThreshold: 1,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();

		expect(recoverGatewayVm).not.toHaveBeenCalled();
	});

	it('does not hide an unhealthy channel provider behind another provider healthy event', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'failed',
			unhealthySinceMs: 1_000,
			zoneId: 'sunfam',
		});
		healthEventStore.record({
			channelProviderId: 'secondary-channel',
			health: 'healthy',
			kind: 'agent-channel-provider-health',
			observedAtMs: 2_000,
			result: 'ok',
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 3,
				channelProviderHealth: {
					enabled: true,
					consecutiveFailureThreshold: 3,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();
		expect(recoverGatewayVm).not.toHaveBeenCalled();
		nowMs = 20_000;
		await monitor.tick();
		expect(recoverGatewayVm).not.toHaveBeenCalled();
		nowMs = 30_000;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledWith({
			consecutiveFailures: 3,
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('does not recover the gateway VM for a failed Tool VM SSH lease event', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			agentId: 'main',
			elapsedMs: 5_000,
			errorCode: 'ssh-command-failed',
			kind: 'tool-vm-ssh',
			leaseId: 'lease-tool-1',
			observedAtMs: 1_000,
			operation: 'command',
			result: 'failed',
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();

		expect(recoverGatewayVm).not.toHaveBeenCalled();
	});

	it('uses channel-provider transition timeout instead of global health staleness', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			health: 'transitioning',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'ok',
			transitionStartedAtMs: 1_000,
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			elapsedMs: 45_000,
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			result: 'ok' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				channelProviderHealth: {
					enabled: true,
					consecutiveFailureThreshold: 1,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 40_000;
		await monitor.tick();
		expect(recoverGatewayVm).not.toHaveBeenCalled();

		nowMs = 121_001;
		await monitor.tick();
		expect(recoverGatewayVm).toHaveBeenCalledWith({
			consecutiveFailures: 1,
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('does not auto restart again inside the 61 minute cooldown', async () => {
		let nowMs = 0;
		const recoverGatewayVm = vi.fn(async () => ({
			action: 'gateway-vm-restart' as const,
			elapsedMs: 1,
			errorCode: 'restart-threw',
			oldVmId: 'old-gateway-vm',
			result: 'failed' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart,
			healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		for (let index = 1; index <= 13; index += 1) {
			nowMs = index * 10_000;
			await monitor.tick();
		}

		expect(recoverGatewayVm).toHaveBeenCalledOnce();
	});

	it('records a suspended recovery event after repeated failed recoveries', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 30,
			staleAfterMs: 30_000,
		});
		const recoverGatewayVm = vi.fn(async () => ({
			action: 'gateway-vm-restart' as const,
			elapsedMs: 1,
			errorCode: 'restart-threw',
			oldVmId: 'old-gateway-vm',
			result: 'failed' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				maxConsecutiveFailedRecoveries: 2,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(2);
		expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
			expect.objectContaining({
				consecutiveFailedRecoveries: 2,
				errorCode: 'max-failed-recoveries',
				kind: 'gateway-recovery-suspended',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		);
	});

	it('preserves cold-start action when repeated cold-start recoveries are suspended', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 30,
			staleAfterMs: 30_000,
		});
		const recoverGatewayVm = vi.fn(async () => ({
			action: 'gateway-vm-cold-start' as const,
			elapsedMs: 1,
			errorCode: 'cold-start-verification-failed',
			result: 'failed' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			classifyRecoveryBudgetClass: () => 'gateway-vm-cold-start',
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				maxConsecutiveFailedRecoveries: 2,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();

		expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
			expect.objectContaining({
				action: 'gateway-vm-cold-start',
				consecutiveFailedRecoveries: 2,
				errorCode: 'max-failed-recoveries',
				kind: 'gateway-recovery-suspended',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		);
	});

	it('does not let a failed running restart budget suppress failed-runtime cold-start recovery', async () => {
		let nowMs = 0;
		let classifyCount = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 30,
			staleAfterMs: 30_000,
		});
		const recoverGatewayVm = vi
			.fn()
			.mockResolvedValueOnce({
				action: 'gateway-vm-restart' as const,
				elapsedMs: 1,
				errorCode: 'restart-threw',
				oldVmId: 'old-gateway-vm',
				result: 'failed' as const,
			})
			.mockResolvedValueOnce({
				action: 'gateway-vm-cold-start' as const,
				elapsedMs: 1,
				errorCode: 'cold-start-verification-failed',
				result: 'failed' as const,
			});
		const monitor = createGatewayServiceHealthMonitor({
			classifyRecoveryBudgetClass: () => {
				classifyCount += 1;
				return classifyCount === 1 ? 'gateway-vm-restart' : 'gateway-vm-cold-start';
			},
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				maxConsecutiveFailedRecoveries: 1,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();
		nowMs = 20_000;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(2);
		expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
			expect.objectContaining({
				action: 'gateway-vm-cold-start',
				errorCode: 'cold-start-verification-failed',
				kind: 'gateway-recovery',
				result: 'failed',
			}),
		);
	});

	it('does not attach stale restart operation ids to later suspended cold-start recovery', async () => {
		let nowMs = 0;
		let classifyCount = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 50,
			staleAfterMs: 30_000,
		});
		const recoverGatewayVm = vi
			.fn()
			.mockResolvedValueOnce({
				action: 'gateway-vm-restart' as const,
				elapsedMs: 1,
				errorCode: 'restart-threw',
				oldVmId: 'old-gateway-vm',
				operationId: 'restart-op-1',
				result: 'failed' as const,
			})
			.mockResolvedValueOnce({
				action: 'gateway-vm-cold-start' as const,
				elapsedMs: 1,
				errorCode: 'cold-start-verification-failed',
				result: 'failed' as const,
			});
		const monitor = createGatewayServiceHealthMonitor({
			classifyRecoveryBudgetClass: ({ reason }) => {
				if (reason === 'agent-channel-provider-unhealthy') {
					return 'gateway-vm-cold-start';
				}
				classifyCount += 1;
				return classifyCount === 1 ? 'gateway-vm-restart' : 'gateway-vm-cold-start';
			},
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				channelProviderHealth: {
					consecutiveFailureThreshold: 1,
					enabled: true,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
				consecutiveFailureThreshold: 1,
				maxConsecutiveFailedRecoveries: 1,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi
				.fn()
				.mockResolvedValueOnce({
					ok: false,
					path: '/health',
					port: 18789,
					statusCode: 502,
					zoneId: 'sunfam',
				})
				.mockResolvedValue({
					ok: true,
					path: '/health',
					port: 18789,
					statusCode: 200,
					zoneId: 'sunfam',
				}),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();
		healthEventStore.record({
			channelProviderId: 'primary-channel',
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 20_000,
			result: 'failed',
			unhealthySinceMs: 20_000,
			zoneId: 'sunfam',
		});
		nowMs = 20_000;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(2);
		const suspendedEvent = healthEventStore
			.listLatestEventsForZone('sunfam')
			.find(
				(event) =>
					event.kind === 'gateway-recovery-suspended' &&
					event.reason === 'agent-channel-provider-unhealthy',
			);
		expect(suspendedEvent).toEqual(
			expect.objectContaining({
				action: 'gateway-vm-cold-start',
				errorCode: 'max-failed-recoveries',
				kind: 'gateway-recovery-suspended',
				reason: 'agent-channel-provider-unhealthy',
				result: 'failed',
			}),
		);
		expect(suspendedEvent === undefined ? undefined : 'operationId' in suspendedEvent).toBe(false);
	});

	it('does not spend failed-recovery budget when recovery is observe-only', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 30,
			staleAfterMs: 30_000,
		});
		const recoverGatewayVm = vi.fn(async () => ({
			action: 'observe-only' as const,
			elapsedMs: 1,
			errorCode: 'recovery-in-flight',
			result: 'failed' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				maxConsecutiveFailedRecoveries: 1,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(2);
		expect(healthEventStore.listLatestEventsForZone('sunfam')).not.toContainEqual(
			expect.objectContaining({
				kind: 'gateway-recovery-suspended',
			}),
		);
	});

	it('suspends repeated failed control-link recoveries even when gateway service remains healthy', async () => {
		let nowMs = 0;
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 30,
			staleAfterMs: 30_000,
		});
		healthEventStore.record({
			controllerHost: 'controller.vm.host',
			controllerPort: 18800,
			elapsedMs: 1,
			kind: 'gateway-control-link',
			observedAtMs: 1_000,
			operation: 'controller-health',
			path: '/health',
			result: 'ok',
			zoneId: 'sunfam',
		});
		const recoverGatewayVm = vi.fn(async () => ({
			action: 'gateway-vm-restart' as const,
			elapsedMs: 1,
			errorCode: 'restart-threw',
			oldVmId: 'old-gateway-vm',
			result: 'failed' as const,
		}));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				maxConsecutiveFailedRecoveries: 2,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				port: 18789,
				statusCode: 200,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 40_000;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();
		nowMs += gatewayServiceAutoRestart.cooldownMs + 1;
		await monitor.tick();

		expect(recoverGatewayVm).toHaveBeenCalledTimes(2);
		expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
			expect.objectContaining({
				consecutiveFailedRecoveries: 2,
				errorCode: 'max-failed-recoveries',
				kind: 'gateway-recovery-suspended',
				reason: 'gateway-control-link-unhealthy',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		);
	});

	it('waits for the recovery callback to settle before recording recovery failure', async () => {
		let nowMs = 0;
		let resolveRecovery:
			| ((result: Extract<GatewayVmRecoveryResult, { readonly result: 'failed' }>) => void)
			| undefined;
		const healthEventStore = new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 });
		const recoverGatewayVm = vi.fn(
			async () =>
				await new Promise<Extract<GatewayVmRecoveryResult, { readonly result: 'failed' }>>(
					(resolve) => {
						resolveRecovery = resolve;
					},
				),
		);
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 10,
				enabled: true,
				failedRecoveryResetMs: 24 * 60 * 60 * 1000,
				maxConsecutiveFailedRecoveries: 3,
				restartTimeoutMs: 5_000,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		for (let index = 1; index <= 9; index += 1) {
			nowMs = index * 10_000;
			await monitor.tick();
		}
		nowMs = 100_000;
		const tickPromise = monitor.tick();
		await vi.waitFor(() => {
			expect(recoverGatewayVm).toHaveBeenCalledOnce();
		});
		nowMs = 105_000;

		expect(healthEventStore.listLatestEventsForZone('sunfam')).not.toContainEqual(
			expect.objectContaining({
				kind: 'gateway-recovery',
				result: 'failed',
			}),
		);

		resolveRecovery?.({
			action: 'gateway-vm-restart',
			elapsedMs: 5_000,
			errorCode: 'recovery-timeout',
			result: 'failed',
		});
		await tickPromise;

		expect(healthEventStore.listLatestEventsForZone('sunfam')).toContainEqual(
			expect.objectContaining({
				errorCode: 'recovery-timeout',
				kind: 'gateway-recovery',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		);
	});

	it('does not start an overlapping recovery while the previous recovery callback is unsettled', async () => {
		let nowMs = 0;
		let resolveRecovery:
			| ((result: Extract<GatewayVmRecoveryResult, { readonly result: 'failed' }>) => void)
			| undefined;
		const healthEventStore = new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 });
		const recoverGatewayVm = vi.fn(
			async () =>
				await new Promise<Extract<GatewayVmRecoveryResult, { readonly result: 'failed' }>>(
					(resolve) => {
						resolveRecovery = resolve;
					},
				),
		);
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 1,
				enabled: true,
				failedRecoveryResetMs: 24 * 60 * 60 * 1000,
				maxConsecutiveFailedRecoveries: 3,
				restartTimeoutMs: 5_000,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		nowMs = 10_000;
		const firstTickPromise = monitor.tick();
		await vi.waitFor(() => {
			expect(recoverGatewayVm).toHaveBeenCalledOnce();
		});
		nowMs = 20_000;
		let secondTickSettled = false;
		const secondTickPromise = monitor.tick().then(() => {
			secondTickSettled = true;
		});
		await Promise.resolve();

		expect(recoverGatewayVm).toHaveBeenCalledOnce();
		expect(secondTickSettled).toBe(false);

		resolveRecovery?.({
			action: 'gateway-vm-restart',
			elapsedMs: 5_000,
			errorCode: 'recovery-timeout',
			result: 'failed',
		});
		await firstTickPromise;
		await secondTickPromise;
	});

	it('keeps one zone probing while another zone recovery is still in flight', async () => {
		let nowMs = 0;
		let resolveSlowRecovery: (() => void) | undefined;
		const probeZoneHealth = vi.fn(async (zoneId: string) => ({
			ok: zoneId === 'fast-zone',
			path: '/health',
			port: 18789,
			statusCode: zoneId === 'fast-zone' ? 200 : 502,
			zoneId,
		}));
		const recoverGatewayVm = vi.fn(
			async (request): Promise<GatewayVmRecoveryResult> =>
				await new Promise((resolve) => {
					if (request.zoneId !== 'slow-zone') {
						throw new Error(`unexpected recovery for ${request.zoneId}`);
					}
					resolveSlowRecovery = () =>
						resolve({
							action: 'gateway-vm-restart',
							elapsedMs: 5_000,
							errorCode: 'recovery-timeout',
							oldVmId: 'old-gateway-vm',
							result: 'failed',
						});
				}),
		);
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				cooldownMs: 0,
			},
			healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth,
			recoverGatewayVm,
			staleAfterMs: 30_000,
			zoneIds: ['slow-zone', 'fast-zone'],
		});

		nowMs = 10_000;
		const firstTickPromise = monitor.tick();
		await vi.waitFor(() => {
			expect(recoverGatewayVm).toHaveBeenCalledOnce();
		});
		expect(probeZoneHealth.mock.calls.filter(([zoneId]) => zoneId === 'fast-zone')).toHaveLength(1);

		nowMs = 20_000;
		const secondTickPromise = monitor.tick();
		await vi.waitFor(() => {
			expect(probeZoneHealth.mock.calls.filter(([zoneId]) => zoneId === 'fast-zone')).toHaveLength(
				2,
			);
		});
		let secondTickSettled = false;
		void secondTickPromise.then(() => {
			secondTickSettled = true;
		});
		await Promise.resolve();
		expect(secondTickSettled).toBe(false);

		let stopSettled = false;
		const stopPromise = monitor.stop().then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		expect(stopSettled).toBe(false);

		resolveSlowRecovery?.();
		await firstTickPromise;
		await secondTickPromise;
		await stopPromise;
		expect(stopSettled).toBe(true);
	});

	it('does not start new zone work from a queued interval callback after stop begins', async () => {
		let nowMs = 0;
		let scheduledCallback: (() => void | Promise<void>) | undefined;
		let resolveSlowRecovery: (() => void) | undefined;
		const probeZoneHealth = vi.fn(async (zoneId: string) => ({
			ok: zoneId === 'fast-zone',
			path: '/health',
			port: 18789,
			statusCode: zoneId === 'fast-zone' ? 200 : 502,
			zoneId,
		}));
		const recoverGatewayVm = vi.fn(
			async (request): Promise<GatewayVmRecoveryResult> =>
				await new Promise((resolve) => {
					if (request.zoneId !== 'slow-zone') {
						throw new Error(`unexpected recovery for ${request.zoneId}`);
					}
					resolveSlowRecovery = () =>
						resolve({
							action: 'gateway-vm-restart',
							elapsedMs: 5_000,
							errorCode: 'recovery-timeout',
							oldVmId: 'old-gateway-vm',
							result: 'failed',
						});
				}),
		);
		const monitor = createGatewayServiceHealthMonitor({
			clearIntervalImpl: vi.fn(),
			gatewayServiceAutoRestart: {
				...gatewayServiceAutoRestart,
				consecutiveFailureThreshold: 1,
				cooldownMs: 0,
			},
			healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth,
			recoverGatewayVm,
			setIntervalImpl: (callback) => {
				scheduledCallback = callback;
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			staleAfterMs: 30_000,
			zoneIds: ['slow-zone', 'fast-zone'],
		});

		monitor.start();
		nowMs = 10_000;
		const firstTickPromise = monitor.tick();
		await vi.waitFor(() => {
			expect(recoverGatewayVm).toHaveBeenCalledOnce();
		});
		expect(probeZoneHealth.mock.calls.filter(([zoneId]) => zoneId === 'fast-zone')).toHaveLength(1);

		const stopPromise = monitor.stop();
		await scheduledCallback?.();

		expect(probeZoneHealth.mock.calls.filter(([zoneId]) => zoneId === 'fast-zone')).toHaveLength(1);

		resolveSlowRecovery?.();
		await firstTickPromise;
		await stopPromise;
	});

	it('awaits an in-flight recovery tick when the monitor stops', async () => {
		let resolveRecovery: (() => void) | undefined;
		const recoverGatewayVm = vi.fn(
			async () =>
				await new Promise<{
					readonly elapsedMs: number;
					readonly leaseReleaseFailureCount: number;
					readonly newBootedAt: string;
					readonly newHostPid: number;
					readonly newVmId: string;
					readonly oldBootedAt: string;
					readonly oldHostPid: number;
					readonly oldVmId: string;
					readonly result: 'ok';
				}>((resolve) => {
					resolveRecovery = () =>
						resolve({
							elapsedMs: 1,
							leaseReleaseFailureCount: 0,
							newBootedAt: '2026-05-27T13:01:00.000Z',
							newHostPid: 2222,
							newVmId: 'new-gateway-vm',
							oldBootedAt: '2026-05-27T13:00:00.000Z',
							oldHostPid: 1111,
							oldVmId: 'old-gateway-vm',
							result: 'ok',
						});
				}),
		);
		const monitor = createGatewayServiceHealthMonitor({
			clearIntervalImpl: vi.fn(),
			gatewayServiceAutoRestart: {
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 1,
				enabled: true,
				failedRecoveryResetMs: 24 * 60 * 60 * 1000,
				maxConsecutiveFailedRecoveries: 3,
				restartTimeoutMs: 10 * 60 * 1000,
			},
			healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
			intervalMs: 10_000,
			now: () => 10_000,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/health',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			setIntervalImpl: () => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout,
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		monitor.start();
		const tickPromise = monitor.tick();
		await vi.waitFor(() => {
			expect(recoverGatewayVm).toHaveBeenCalledOnce();
		});
		const stopPromise = monitor.stop();
		resolveRecovery?.();
		await tickPromise;
		await stopPromise;
	});
});
