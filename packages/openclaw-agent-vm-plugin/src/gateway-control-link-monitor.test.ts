import { describe, expect, it, vi } from 'vitest';

import { createGatewayControlLinkMonitor } from './gateway-control-link-monitor.js';

describe('createGatewayControlLinkMonitor', () => {
	it('publishes ok gateway control-link events after controller health succeeds', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

		const monitor = createGatewayControlLinkMonitor({
			baseIntervalMs: 10_000,
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
			maxIntervalMs: 120_000,
			now: () => 12_000,
			zoneId: 'beta',
		});

		await monitor.tick();

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			'http://controller.vm.host:18800/health',
			expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
		);
		const publishBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as {
			readonly kind: string;
			readonly result: string;
			readonly zoneId: string;
		};
		expect(fetchImpl.mock.calls[1]?.[0]).toBe(
			'http://controller.vm.host:18800/zones/beta/health-events',
		);
		expect(publishBody).toMatchObject({
			kind: 'gateway-control-link',
			result: 'ok',
			zoneId: 'beta',
		});
	});

	it('keeps consecutive failure count until controller health returns ok', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 503 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		const monitor = createGatewayControlLinkMonitor({
			baseIntervalMs: 10_000,
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
			maxIntervalMs: 120_000,
			now: () => 12_000,
			zoneId: 'beta',
		});

		await monitor.tick();
		expect(monitor.consecutiveFailureCount()).toBe(1);

		await monitor.tick();
		expect(monitor.consecutiveFailureCount()).toBe(0);
	});

	it('logs publish failures without throwing out of tick', async () => {
		const writeLog = vi.fn();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
			.mockRejectedValueOnce(new Error('publish path down'));
		const monitor = createGatewayControlLinkMonitor({
			baseIntervalMs: 10_000,
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
			maxIntervalMs: 120_000,
			now: () => 12_000,
			writeLog,
			zoneId: 'beta',
		});

		await expect(monitor.tick()).resolves.toBeUndefined();

		expect(writeLog).toHaveBeenCalledWith(
			expect.stringContaining('gateway-control-link publish failed'),
		);
	});

	it('backs off scheduled ticks after failures and stops the timer', async () => {
		const unref = vi.fn();
		const timer = { unref } as unknown as NodeJS.Timeout;
		const setTimeoutImpl = vi.fn(() => timer);
		const clearTimeoutImpl = vi.fn();
		const monitor = createGatewayControlLinkMonitor({
			baseIntervalMs: 10_000,
			clearTimeoutImpl,
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: vi.fn(),
			maxIntervalMs: 120_000,
			now: () => 12_000,
			setTimeoutImpl,
			zoneId: 'beta',
		});

		monitor.noteFailureForTest();
		monitor.start();
		monitor.stop();

		expect(setTimeoutImpl).toHaveBeenCalledWith(expect.any(Function), 20_000);
		expect(unref).toHaveBeenCalledOnce();
		expect(clearTimeoutImpl).toHaveBeenCalledWith(timer);
	});

	it('does not schedule a new timer when stopped while a tick is in flight', async () => {
		const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
		let scheduledCallback: (() => void) | undefined;
		let resolveHealth: ((response: Response) => void) | undefined;
		const setTimeoutImpl = vi.fn((callback: () => void) => {
			scheduledCallback = callback;
			return timer;
		});
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(
				async () =>
					await new Promise<Response>((resolve) => {
						resolveHealth = resolve;
					}),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		const monitor = createGatewayControlLinkMonitor({
			baseIntervalMs: 10_000,
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl,
			maxIntervalMs: 120_000,
			now: () => 12_000,
			setTimeoutImpl,
			zoneId: 'beta',
		});

		monitor.start();
		scheduledCallback?.();
		monitor.stop();
		resolveHealth?.(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		await Promise.resolve();
		await Promise.resolve();

		expect(setTimeoutImpl).toHaveBeenCalledOnce();
	});
});
