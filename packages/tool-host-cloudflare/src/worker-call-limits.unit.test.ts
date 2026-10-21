import { describe, expect, it } from 'vitest';

import { createBatchScheduler } from '#worker-host/worker-call-limits';

describe('whole-call Worker batch scheduling', () => {
	it('admits six whole calls and releases the next six only on completion', async () => {
		const scheduler = createBatchScheduler();
		const releases: (() => void)[] = [];
		let running = 0;
		let peak = 0;
		const started = Promise.withResolvers<void>();
		const calls = Array.from({ length: 12 }, async () =>
			scheduler.run(async () => {
				running += 1;
				peak = Math.max(peak, running);
				if (running === 6) started.resolve();
				await new Promise<void>((resolve) => releases.push(resolve));
				running -= 1;
			}),
		);
		await started.promise;
		expect(releases).toHaveLength(6);
		for (const release of releases.splice(0)) release();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		for (const release of releases.splice(0)) release();
		await Promise.all(calls);
		expect(peak).toBe(6);
		expect(running).toBe(0);
	});
});
