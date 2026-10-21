import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	portalRead,
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';
import { waitForProtocolRetryInterval } from '#worker-host/test-fixtures/protocol-observation-interval';

const executeFile = promisify(execFile);
let harness: LocalWorkerHarness;
interface SocketSnapshot {
	readonly pid: number;
	readonly established: number;
	readonly closeWait: number;
}
async function ownedWorkerdPids(): Promise<number[]> {
	const { stdout } = await executeFile('ps', ['-axo', 'pid,ppid,command']);
	return stdout.split('\n').flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
		return match?.[1] !== undefined &&
			Number(match[2]) === process.pid &&
			match[3]?.includes('/workerd serve')
			? [Number(match[1])]
			: [];
	});
}
async function sockets(pids: readonly number[]): Promise<SocketSnapshot[]> {
	return Promise.all(
		pids.map(async (pid) => {
			const { stdout } = await executeFile('lsof', [
				'-nP',
				'-a',
				'-p',
				String(pid),
				'-iTCP',
				'-F',
				'pT',
			]);
			return {
				pid,
				established: stdout.split('\n').filter((line) => line === 'TST=ESTABLISHED').length,
				closeWait: stdout.split('\n').filter((line) => line === 'TST=CLOSE_WAIT').length,
			};
		}),
	);
}
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
		for (const snapshot of after) {
			const before = baseline.find((entry) => entry.pid === snapshot.pid);
			expect(before).toBeDefined();
			expect(snapshot.closeWait).toBe(0);
			expect(snapshot.established).toBeLessThanOrEqual(before?.established ?? 0);
		}
	});
});
