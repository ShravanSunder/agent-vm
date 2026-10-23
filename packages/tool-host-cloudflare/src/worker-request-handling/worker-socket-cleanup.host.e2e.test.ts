import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	portalRead,
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';
import { waitForProtocolRetryInterval } from '#worker-host/test-fixtures/protocol-observation-interval';
import {
	ownedWorkerdPids,
	workerdSockets as sockets,
} from '#worker-host/test-fixtures/workerd-socket-guard';
let harness: LocalWorkerHarness;
describe('request-owned MCP socket cleanup in still-live local workerd', () => {
	beforeAll(async () => {
		harness = await startLocalWorkerHarness({
			setup: (fixture) => fixture.setBackgroundStreams(true),
		});
	});
	afterAll(async () => {
		await harness?.close();
	});
	it('returns sockets to warm baseline after bounded sequential/concurrent successful and failed calls', async () => {
		// Warm the exact concurrency used below so keep-alive pool growth is part of the baseline.
		await Promise.all(
			Array.from({ length: 6 }, async () =>
				rpcResult(await harness.rpc('tools/call', portalRead())),
			),
		);
		const pids = await ownedWorkerdPids();
		expect(pids).toHaveLength(2);
		const baseline = await sockets(pids);
		for (const index of Array.from({ length: 12 }, (_, value) => value)) {
			// Sequential protocol operations are the workload being proved, not a retry wait.
			await rpcResult(await harness.rpc('tools/call', portalRead(index)));
		}
		await Promise.all(
			Array.from({ length: 6 }, async (_, index) =>
				rpcResult(await harness.rpc('tools/call', portalRead(index))),
			),
		);
		harness.fixture.setCall(async () => ({
			isError: true,
			content: [{ type: 'text', text: 'controlled failure' }],
		}));
		await Promise.all(
			Array.from({ length: 6 }, async () =>
				rpcResult(await harness.rpc('tools/call', portalRead())),
			),
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.fixture.setCall(async () => {
			entered.resolve();
			await release.promise;
			return { content: [{ type: 'text', text: 'after-abort' }] };
		});
		const cancellation = new AbortController();
		const aborted = harness.rpc('tools/call', portalRead('abort'), { signal: cancellation.signal });
		await entered.promise;
		cancellation.abort();
		await expect(aborted).rejects.toThrow();
		release.resolve();
		// This explicit follow-up event proves the isolate is responsive after the aborted exchange.
		await rpcResult(await harness.rpc('server/discover'));
		// Real OS/socket recovery, bounded to 10s; no internal application timer is being tested.
		const deadline = Date.now() + 10_000;
		let after = await sockets(pids);
		while (
			after.some(
				(entry) =>
					entry.closeWait !== 0 ||
					entry.established >
						(baseline.find((before) => before.pid === entry.pid)?.established ?? 0),
			) &&
			Date.now() < deadline
		) {
			await waitForProtocolRetryInterval();
			after = await sockets(pids);
		}
		process.stdout.write(
			`${JSON.stringify({ socketProof: 'still-live-workerd', baseline, after, activeUpstreamStreams: harness.fixture.activeBackgroundStreams() })}\n`,
		);
		expect(await ownedWorkerdPids()).toEqual(pids);
		expect(harness.fixture.activeBackgroundStreams()).toBe(0);
		const closures = z
			.array(z.object({ id: z.number(), closed: z.number() }))
			.parse(await (await harness.worker.fetch('/__clients')).json());
		expect(closures.length).toBeGreaterThan(20);
		expect(
			closures.every((client) => client.closed === 1),
			JSON.stringify(closures),
		).toBe(true);
		for (const snapshot of after) {
			const before = baseline.find((entry) => entry.pid === snapshot.pid);
			expect(before).toBeDefined();
			expect(snapshot.closeWait).toBe(0);
			expect(snapshot.established).toBeLessThanOrEqual(before?.established ?? 0);
		}
	});
});
