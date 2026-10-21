import { afterEach, expect, it, vi } from 'vitest';

import { responseWithRequestCleanup } from '#worker-host/worker-host';
afterEach(() => {
	vi.useRealTimers();
});

it('awaits request cleanup before returning a bodyless response', async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let settled = false;
	let closes = 0;
	const response = new Response(null, { status: 202 });
	const result = Promise.resolve(
		responseWithRequestCleanup(response, async () => {
			closes += 1;
			entered.resolve();
			await release.promise;
		}),
	).then((value) => {
		settled = true;
		return value;
	});
	await entered.promise;
	try {
		expect(settled).toBe(false);
	} finally {
		release.resolve();
		await result;
	}
	expect(closes).toBe(1);
	expect(settled).toBe(true);
});

it('awaits cleanup at EOF before completing the response', async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let settled = false;
	let closes = 0;
	const response = await responseWithRequestCleanup(new Response('complete'), async () => {
		closes += 1;
		entered.resolve();
		await release.promise;
	});
	const result = response.text().then((value) => {
		settled = true;
		return value;
	});
	await entered.promise;
	try {
		expect(settled).toBe(false);
	} finally {
		release.resolve();
	}
	expect(await result).toBe('complete');
	expect(closes).toBe(1);
});

it('awaits the same pending cleanup when cancellation races an upstream EOF', async () => {
	vi.useFakeTimers();
	const reading = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let closes = 0;
	let settled = false;
	const original = new ReadableStream<Uint8Array>({
		pull: () => {
			reading.resolve();
		},
	});
	const response = await responseWithRequestCleanup(new Response(original), async () => {
		closes += 1;
		entered.resolve();
		await release.promise;
	});
	await reading.promise;
	const result = response.body?.cancel().then(() => {
		settled = true;
	});
	await entered.promise;
	// Drain deterministic promise work while cleanup remains explicitly blocked.
	await vi.advanceTimersByTimeAsync(0);
	try {
		expect(settled).toBe(false);
	} finally {
		release.resolve();
	}
	await result;
	expect(closes).toBe(1);
	expect(settled).toBe(true);
});

it('closes the request once when the upstream response stream fails', async () => {
	const failure = new Error('controlled response stream failure');
	let closes = 0;
	const original = new ReadableStream<Uint8Array>({
		start: (controller) => controller.error(failure),
	});
	const response = await responseWithRequestCleanup(new Response(original), async () => {
		closes += 1;
	});
	await expect(response.text()).rejects.toThrow('controlled response stream failure');
	expect(closes).toBe(1);
});
