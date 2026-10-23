import { afterEach, expect, it, vi } from 'vitest';

import { waitForPortalCompositionHermesHealth } from '#agent-vm/integration-tests/portal-composition-hermes-e2e-support';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('keeps the health deadline failure and controller diagnostics when the VM log tail fails', async () => {
	vi.useFakeTimers();
	const requestedUrls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string): Promise<Response> => {
			requestedUrls.push(url);
			if (url.endsWith('/health')) return new Response('starting', { status: 503 });
			return new Response(url.endsWith('/status') ? 'controller status' : 'controller logs');
		}),
	);
	const exec = vi.fn().mockRejectedValue(new Error('vm is closed and cannot be restarted'));
	const observation = waitForPortalCompositionHermesHealth({
		controllerUrl: 'http://controller.invalid',
		gatewayPort: 12345,
		resolveVm: () => ({ exec }),
		zoneId: 'test-zone',
	}).catch((error: unknown) => error);

	await vi.advanceTimersByTimeAsync(60_000);
	const failure = await observation;

	expect(failure).toBeInstanceOf(Error);
	expect(String(failure)).toContain('Timed out waiting for portal composition Hermes health');
	expect(String(failure)).toContain('"lastStatus":503');
	expect(String(failure)).toContain('"serviceLogError":"vm is closed and cannot be restarted"');
	expect(String(failure)).toContain('controller status');
	expect(String(failure)).toContain('controller logs');
	expect(exec).toHaveBeenCalledOnce();
	expect(requestedUrls).toContain('http://controller.invalid/zones/test-zone/status');
	expect(requestedUrls).toContain('http://controller.invalid/zones/test-zone/logs');
});
