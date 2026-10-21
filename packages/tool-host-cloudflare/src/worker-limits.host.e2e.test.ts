import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	portalRead,
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';
import {
	workerRequestBodyBytes,
	workerReplyBytes,
	workerUpstreamResponseBytes,
} from '#worker-host/worker-call-limits';

let harness: LocalWorkerHarness;
function calls(count: number): Readonly<Record<string, unknown>> {
	return {
		name: 'mcp_portal_call',
		arguments: {
			calls: Array.from({ length: count }, (_, index) => ({
				id: String(index),
				namespace: 'same-server',
				toolName: 'read',
				arguments: { value: String(index) },
			})),
		},
	};
}
describe('Worker limits through local workerd', () => {
	beforeAll(async () => {
		harness = await startLocalWorkerHarness();
	});
	afterAll(async () => {
		await harness?.close();
	});
	it('accepts exactly4MiB body and rejects one byte more with413', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 'size',
			method: 'tools/call',
			params: {
				...portalRead('body-limit'),
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '2026-07-28',
					'io.modelcontextprotocol/clientCapabilities': {},
				},
			},
		});
		const headers = {
			authorization: `Bearer ${harness.token}`,
			'content-type': 'application/json',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': 'tools/call',
			'Mcp-Name': 'mcp_portal_call',
		};
		const before = harness.fixture.calls.length;
		const allowed = await harness.worker.fetch('/mcp', {
			method: 'POST',
			headers,
			body: body + ' '.repeat(workerRequestBodyBytes - body.length),
		});
		await rpcResult(allowed);
		expect(harness.fixture.calls).toHaveLength(before + 1);
		const refused = await harness.worker.fetch('/mcp', {
			method: 'POST',
			headers,
			body: body + ' '.repeat(workerRequestBodyBytes + 1 - body.length),
		});
		expect(refused.status).toBe(413);
		expect(harness.fixture.calls).toHaveLength(before + 1);
	});
	it('allows50 calls and rejects51 before any effect', async () => {
		const before = harness.fixture.calls.length;
		await rpcResult(await harness.rpc('tools/call', calls(50)));
		expect(harness.fixture.calls).toHaveLength(before + 50);
		const refused = await rpcResult(await harness.rpc('tools/call', calls(51)));
		expect(JSON.stringify(refused)).toContain('too_many_calls');
		expect(harness.fixture.calls).toHaveLength(before + 50);
	});
	it('keeps no more than6 of12 slow calls in flight until each response completes', async () => {
		const firstWave = Promise.withResolvers<void>();
		const secondWave = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		let entered = 0;
		const releases: (() => void)[] = [];
		harness.fixture.setCall(async () => {
			active += 1;
			entered += 1;
			peak = Math.max(peak, active);
			if (entered === 6) firstWave.resolve();
			if (entered === 12) secondWave.resolve();
			await new Promise<void>((resolve) => releases.push(resolve));
			active -= 1;
			return { content: [{ type: 'text', text: 'slow-complete' }] };
		});
		const running = harness.rpc('tools/call', calls(12)).then(rpcResult);
		await firstWave.promise;
		expect(entered).toBe(6);
		expect(active).toBe(6);
		for (const release of releases.splice(0)) release();
		await secondWave.promise;
		for (const release of releases.splice(0)) release();
		await running;
		expect(peak).toBe(6);
		expect(entered).toBe(12);
		expect(active).toBe(0);
	});
	it('measures each upstream result before redaction at4MiB', async () => {
		const envelopeBytes = JSON.stringify({ content: [{ type: 'text', text: '' }] }).length;
		harness.fixture.setCall(async () => ({
			content: [{ type: 'text', text: 'x'.repeat(workerUpstreamResponseBytes - envelopeBytes) }],
		}));
		const allowed = await rpcResult(await harness.rpc('tools/call', portalRead()));
		expect(JSON.stringify(allowed)).not.toContain('upstream-unavailable');
		harness.fixture.setCall(async () => ({
			content: [
				{ type: 'text', text: 'x'.repeat(workerUpstreamResponseBytes - envelopeBytes + 1) },
			],
		}));
		const refused = await rpcResult(await harness.rpc('tools/call', portalRead()));
		expect(JSON.stringify(refused)).toContain('too_large_result');
		// A response consisting of a credential is large BEFORE exact-value redaction shrinks it.
		harness.fixture.setCall(async () => ({
			content: [{ type: 'text', text: 'one-secret-canary'.repeat(300_000) }],
		}));
		const redactedTooLarge = await rpcResult(await harness.rpc('tools/call', portalRead()));
		expect(JSON.stringify(redactedTooLarge)).toContain('too_large_result');
		expect(JSON.stringify(redactedTooLarge)).not.toContain('one-secret-canary');
	});
	it('returns too-large items as accumulated replies pass16MiB and survives overlapping requests', async () => {
		harness.fixture.setCall(async () => ({
			content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }],
		}));
		const responses = await Promise.all(
			Array.from({ length: 3 }, async () => {
				const response = await harness.rpc('tools/call', calls(8));
				const text = await response.text();
				expect(response.status).toBe(200);
				expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(workerReplyBytes);
				const value = z
					.object({ result: z.record(z.string(), z.unknown()) })
					.parse(JSON.parse(text));
				expect(JSON.stringify(value)).toContain('too_large_result');
				return value;
			}),
		);
		expect(responses).toHaveLength(3);
		const logs = z
			.array(z.object({ event: z.string(), isolateId: z.string(), activeRequests: z.number() }))
			.parse(await (await harness.worker.fetch('/__logs')).json());
		expect(new Set(logs.map((event) => event.isolateId)).size).toBe(1);
		expect(Math.max(...logs.map((event) => event.activeRequests))).toBeGreaterThanOrEqual(3);
	});
});
