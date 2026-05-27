import { describe, expect, it, vi } from 'vitest';

import { createGatewayServiceHealthMonitor } from './gateway-service-health-monitor.js';
import { HealthEventStore } from './health-event-store.js';

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

	it('stops the scheduled monitor timer', () => {
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
			zoneIds: ['beta'],
		});

		monitor.start();
		monitor.stop();

		expect(setIntervalImpl).toHaveBeenCalledOnce();
		expect(clearIntervalImpl).toHaveBeenCalledWith(timer);
		expect(unref).toHaveBeenCalledOnce();
	});
});
