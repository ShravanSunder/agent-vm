import { describe, expect, it, vi } from 'vitest';

import { createGatewayServiceHealthMonitor } from './gateway-service-health-monitor.js';
import { HealthEventStore } from './health-event-store.js';

/* oxlint-disable eslint/no-await-in-loop -- Consecutive monitor ticks are intentionally sequential state transitions. */

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
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 10,
				enabled: true,
				restartTimeoutMs: 10 * 60 * 1000,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/readyz',
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
				newVmId: 'new-gateway-vm',
				oldVmId: 'old-gateway-vm',
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
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 10,
				enabled: true,
				restartTimeoutMs: 10 * 60 * 1000,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/readyz',
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

	it('does not auto restart again inside the 61 minute cooldown', async () => {
		let nowMs = 0;
		const recoverGatewayVm = vi.fn(async () => ({ elapsedMs: 1, result: 'failed' as const }));
		const monitor = createGatewayServiceHealthMonitor({
			gatewayServiceAutoRestart: {
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 10,
				enabled: true,
				restartTimeoutMs: 10 * 60 * 1000,
			},
			healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/readyz',
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

	it('records a failed gateway recovery event when restart exceeds the configured deadline', async () => {
		let nowMs = 0;
		const timeoutCallbacks: (() => void)[] = [];
		const healthEventStore = new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 });
		const recoverGatewayVm = vi.fn(
			async () =>
				await new Promise<never>(() => {
					// Recovery intentionally hangs; the monitor deadline must release the tick.
				}),
		);
		const monitor = createGatewayServiceHealthMonitor({
			clearTimeoutImpl: vi.fn(),
			gatewayServiceAutoRestart: {
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 10,
				enabled: true,
				restartTimeoutMs: 5_000,
			},
			healthEventStore,
			intervalMs: 10_000,
			now: () => nowMs,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/readyz',
				port: 18789,
				statusCode: 502,
				zoneId: 'sunfam',
			})),
			recoverGatewayVm,
			setTimeoutImpl: (callback) => {
				timeoutCallbacks.push(callback);
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			staleAfterMs: 30_000,
			zoneIds: ['sunfam'],
		});

		for (let index = 1; index <= 9; index += 1) {
			nowMs = index * 10_000;
			await monitor.tick();
		}
		nowMs = 100_000;
		const tickPromise = monitor.tick();
		await Promise.resolve();
		nowMs = 105_000;
		timeoutCallbacks[0]?.();
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

	it('awaits an in-flight recovery tick when the monitor stops', async () => {
		let resolveRecovery: (() => void) | undefined;
		const recoverGatewayVm = vi.fn(
			async () =>
				await new Promise<{ readonly elapsedMs: number; readonly result: 'ok' }>((resolve) => {
					resolveRecovery = () => resolve({ elapsedMs: 1, result: 'ok' });
				}),
		);
		const monitor = createGatewayServiceHealthMonitor({
			clearIntervalImpl: vi.fn(),
			gatewayServiceAutoRestart: {
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 1,
				enabled: true,
				restartTimeoutMs: 10 * 60 * 1000,
			},
			healthEventStore: new HealthEventStore({ eventHistoryLimit: 20, staleAfterMs: 30_000 }),
			intervalMs: 10_000,
			now: () => 10_000,
			probeZoneHealth: vi.fn(async () => ({
				ok: false,
				path: '/readyz',
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
