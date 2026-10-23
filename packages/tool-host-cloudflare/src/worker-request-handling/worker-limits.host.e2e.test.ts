import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	portalRead,
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';
import { waitForProtocolRetryInterval } from '#worker-host/test-fixtures/protocol-observation-interval';
// Independent oracle: these values are the governing Worker contract, not product imports.
const workerRequestBodyBytes = 4 * 1024 * 1024;
const workerUpstreamResponseBytes = 4 * 1024 * 1024;
const workerReplyBytes = 16 * 1024 * 1024;

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
		for (const offset of [-1, 0]) {
			const allowed = await harness.worker.fetch('/mcp', {
				method: 'POST',
				headers,
				body: body + ' '.repeat(workerRequestBodyBytes + offset - body.length),
			});
			await rpcResult(allowed);
			expect(harness.fixture.calls).toHaveLength(before + offset + 2);
		}
		const refused = await harness.worker.fetch('/mcp', {
			method: 'POST',
			headers,
			body: body + ' '.repeat(workerRequestBodyBytes + 1 - body.length),
		});
		expect(refused.status).toBe(413);
		expect(harness.fixture.calls).toHaveLength(before + 2);
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
		harness.fixture.setEarlyCallHeaders(true);
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
		// Headers have already arrived; allow queued real socket requests to reach the body barrier.
		await waitForProtocolRetryInterval();
		expect(entered).toBe(6);
		expect(active).toBe(6);
		for (const release of releases.splice(0)) release();
		await secondWave.promise;
		for (const release of releases.splice(0)) release();
		await running;
		expect(peak).toBe(6);
		expect(entered).toBe(12);
		expect(active).toBe(0);
		harness.fixture.setEarlyCallHeaders(false);
	});
	it('measures each upstream result before redaction at4MiB', async () => {
		const envelopeBytes = JSON.stringify({ content: [{ type: 'text', text: '' }] }).length;
		for (const offset of [-1, 0]) {
			const expectedText = 'x'.repeat(workerUpstreamResponseBytes - envelopeBytes + offset);
			harness.fixture.setCall(async () => ({ content: [{ type: 'text', text: expectedText }] }));
			const allowed = await rpcResult(await harness.rpc('tools/call', portalRead()));
			expect(allowed.isError).toBeUndefined();
			// Successful output must survive intact, not merely avoid one particular error kind.
			const content = z
				.object({ content: z.tuple([z.object({ text: z.string() })]) })
				.parse(allowed);
			const core = z
				.object({
					items: z.array(
						z.object({
							status: z.literal('success'),
							structuredContent: z.object({
								result: z.object({
									content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
								}),
							}),
						}),
					),
				})
				.parse(JSON.parse(content.content[0].text));
			expect(core.items[0]?.structuredContent.result.content).toEqual([
				{ type: 'text', text: expectedText },
			]);
			expect(expectedText.length + envelopeBytes).toBe(workerUpstreamResponseBytes + offset);
		}
		harness.fixture.setCall(async () => ({
			content: [
				{ type: 'text', text: 'x'.repeat(workerUpstreamResponseBytes - envelopeBytes + 1) },
			],
		}));
		const refused = await rpcResult(await harness.rpc('tools/call', portalRead()));
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused)).toContain('upstream_call_failed');
		expect(JSON.stringify(refused).length).toBeLessThan(4096);
		// A response consisting of a credential is large BEFORE exact-value redaction shrinks it.
		harness.fixture.setCall(async () => ({
			content: [{ type: 'text', text: 'one-secret-canary'.repeat(300_000) }],
		}));
		const redactedTooLarge = await rpcResult(await harness.rpc('tools/call', portalRead()));
		expect(redactedTooLarge.isError).toBe(true);
		expect(JSON.stringify(redactedTooLarge)).toContain('upstream_call_failed');
		expect(JSON.stringify(redactedTooLarge)).not.toContain('one-secret-canary');
	});
	it('admits just under16MiB and replaces a call just over the whole serialized reply budget', async () => {
		harness.fixture.setCall(async () => ({ content: [{ type: 'text', text: '' }] }));
		const empty = await (await harness.rpc('tools/call', calls(2))).text();
		// The frozen proxy projection places each result in content and structuredContent.
		// Two calls therefore add four ASCII bytes per character of equal result payload.
		const count = Math.floor((workerReplyBytes - new TextEncoder().encode(empty).byteLength) / 4);
		harness.fixture.setCall(async () => ({ content: [{ type: 'text', text: 'x'.repeat(count) }] }));
		const allowed = await (await harness.rpc('tools/call', calls(2))).text();
		expect(allowed).not.toContain('too_large_result');
		expect(new TextEncoder().encode(allowed).byteLength).toBeGreaterThan(workerReplyBytes - 4);
		expect(new TextEncoder().encode(allowed).byteLength).toBeLessThanOrEqual(workerReplyBytes);

		const remainder = workerReplyBytes - new TextEncoder().encode(allowed).byteLength;
		const exactId = 'proof' + 'p'.repeat(remainder);
		const exact = await (await harness.rpc('tools/call', calls(2), { id: exactId })).text();
		expect(exact).not.toContain('too_large_result');
		expect(new TextEncoder().encode(exact).byteLength).toBe(workerReplyBytes);
		const refused = await (await harness.rpc('tools/call', calls(2), { id: exactId + 'p' })).text();
		expect(refused).toContain('too_large_result');
		expect(new TextEncoder().encode(refused).byteLength).toBeLessThanOrEqual(workerReplyBytes);
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
