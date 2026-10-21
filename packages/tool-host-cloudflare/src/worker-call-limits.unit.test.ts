import { describe, expect, it } from 'vitest';

import {
	createBatchScheduler,
	createWorkerRequestLimits,
	projectBoundedWorkerToolResult,
} from '#worker-host/worker-call-limits';

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

describe('raw batch admission precedes all descriptor validation', () => {
	it.each([51, 8000])(
		'counts %s raw entries without reading descriptors, including the refusal projection',
		(count) => {
			let descriptorReads = 0;
			const malformed = Object.defineProperty({}, 'id', {
				get: () => {
					descriptorReads += 1;
					return 'unexpected-descriptor-read';
				},
			});
			const input = { calls: Array.from({ length: count }, () => malformed) };
			const refused = createWorkerRequestLimits().begin(input, 'proof');
			expect(descriptorReads).toBe(0);
			expect(refused?.errors[0]?.kind).toBe('too_many_calls');
			if (refused === undefined) throw new Error('Expected a raw batch refusal.');
			const projected = projectBoundedWorkerToolResult({
				operation: 'mcp_portal_call',
				input,
				result: refused,
				requestId: 'proof',
			});
			expect(JSON.stringify(projected.response)).toContain('too_many_calls');
			expect(descriptorReads).toBe(0);
		},
	);
});
