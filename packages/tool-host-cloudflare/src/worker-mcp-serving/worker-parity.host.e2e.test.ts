import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { startLegacyProxyReference } from '#worker-host/test-fixtures/legacy-proxy-reference-test-fixture';
import {
	startLocalWorkerHarness,
	rpcResult,
	portalRead,
} from '#worker-host/test-fixtures/local-worker-harness';

for (const mode of ['direct', 'indirect'] as const) {
	it(`${mode}: matches08f9e426 lists, results, refusals and helper bytes including provider/connect/broken-stream failures`, async () => {
		const fixedClock = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedClock);
		const harness = await startLocalWorkerHarness({ fixedClock });
		const reference = await startLegacyProxyReference(harness.fixture.url, 'indirect');
		try {
			const path = mode === 'direct' ? '/mcp?tools=direct' : '/mcp';
			const directReference =
				mode === 'direct'
					? await startLegacyProxyReference(harness.fixture.url, 'direct')
					: undefined;
			const oldTools = (await (directReference ?? reference).client.listTools()).tools;
			if (directReference !== undefined) {
				const directName = oldTools.find((tool) =>
					tool.name.startsWith('same-server__read__'),
				)?.name;
				if (directName === undefined) throw new Error('Missing independent reference read tool.');
				const nativeInput = { name: directName, arguments: { value: 'native-parity' } };
				const expectedNative = await directReference.client.callTool(nativeInput);
				const actualNative = await rpcResult(
					await harness.rpc('tools/call', nativeInput, { path }),
				);
				const { _meta, resultType, ...nativeSurface } = actualNative;
				expect(resultType).toBe('complete');
				expect(nativeSurface).toEqual(expectedNative);
				await directReference.close();
			}
			const current = await rpcResult(await harness.rpc('tools/list', {}, { path }));
			expect(current.cacheScope).toBe('private');
			expect(current.ttlMs).toBe(60000);
			const tools = z
				.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) })
				.parse(current).tools;
			if (mode === 'direct')
				expect(tools.filter((tool) => !tool.name.startsWith('mcp_portal_'))).toEqual(oldTools);
			else expect(tools).toEqual(oldTools);
			const compare = async (input: {
				readonly name: string;
				readonly arguments: Record<string, unknown>;
			}): Promise<Record<string, unknown>> => {
				const expected = await reference.client.callTool(input);
				const actual = await rpcResult(await harness.rpc('tools/call', input, { path }));
				const { _meta: metadata, resultType, ...surface } = actual;
				expect(resultType).toBe('complete');
				expect(metadata).toEqual({
					'io.modelcontextprotocol/serverInfo': {
						name: 'tool-host-cloudflare',
						version: '0.0.153',
					},
				});
				expect(surface, JSON.stringify(input)).toEqual(expected);
				return surface;
			};
			await compare({ name: 'mcp_portal_list', arguments: { requests: [{ id: 'list' }] } });
			await compare({
				name: 'mcp_portal_search',
				arguments: { requests: [{ id: 'search', query: 'read' }] },
			});
			await compare({
				name: 'mcp_portal_describe',
				arguments: {
					requests: [
						{
							id: 'describe',
							tools: [{ namespace: 'same-server', toolName: 'read' }],
							includeTypescriptHelper: true,
						},
					],
				},
			});
			await compare({
				name: 'mcp_portal_call',
				arguments: z.record(z.string(), z.unknown()).parse(portalRead(42).arguments),
			});
			await compare({
				name: 'mcp_portal_call',
				arguments: {
					calls: [{ id: 'hidden', namespace: 'same-server', toolName: 'hidden', arguments: {} }],
				},
			});
			await compare({
				name: 'mcp_portal_call',
				arguments: {
					calls: [{ id: 'ask', namespace: 'same-server', toolName: 'ask', arguments: {} }],
				},
			});
			// Independent shape/order/effect assertions make the old-versus-new oracle non-vacuous.
			const readCall = (id: string, value: string): Record<string, unknown> => ({
				id,
				namespace: 'same-server',
				toolName: 'read',
				arguments: { value },
			});
			for (const invalid of [
				{ calls: [] },
				{ calls: [readCall('duplicate', 'one'), readCall('duplicate', 'two')] },
			]) {
				const before = harness.fixture.calls.length;
				const surface = await compare({ name: 'mcp_portal_call', arguments: invalid });
				const text = z.object({ content: z.tuple([z.object({ text: z.string() })]) }).parse(surface)
					.content[0].text;
				const scalar = z
					.object({
						items: z.array(z.unknown()),
						content: z.array(z.object({ type: z.literal('json'), value: z.unknown() })),
						structuredContent: z.object({
							ok: z.literal(false),
							diagnostics: z.array(z.unknown()),
							errors: z.array(z.unknown()).min(1),
							results: z.record(z.string(), z.unknown()),
						}),
					})
					.parse(JSON.parse(text));
				expect(scalar.items).toEqual([]);
				expect(scalar.content).toHaveLength(1);
				expect(scalar.content[0]?.value).toEqual(scalar.structuredContent);
				expect(surface.isError).toBe(true);
				expect(harness.fixture.calls).toHaveLength(before);
			}
			const beforeMixed = harness.fixture.calls.length;
			const mixed = await compare({
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						readCall('2', 'first'),
						{ id: '1', namespace: 'same-server', toolName: 'hidden', arguments: {} },
						readCall('0', 'last'),
					],
				},
			});
			const mixedText = z
				.object({ content: z.tuple([z.object({ text: z.string() })]) })
				.parse(mixed).content[0].text;
			const mixedCore = z
				.object({
					content: z.array(z.unknown()),
					items: z.array(z.object({ requestId: z.string(), status: z.string() })),
				})
				.parse(JSON.parse(mixedText));
			expect(mixedCore.content).toEqual([]);
			expect(mixedCore.items.map(({ requestId, status }) => ({ requestId, status }))).toEqual([
				{ requestId: '2', status: 'success' },
				{ requestId: '1', status: 'failed' },
				{ requestId: '0', status: 'success' },
			]);
			expect(mixed.isError).toBe(true);
			expect(harness.fixture.calls).toHaveLength(beforeMixed + 4); // Two effects on each independent host.
			expect(harness.fixture.calls.slice(beforeMixed).map((call) => call.arguments.value)).toEqual([
				'first',
				'last',
				'first',
				'last',
			]);
			harness.fixture.setCall(async () => ({
				isError: true,
				content: [{ type: 'text', text: 'controlled isError' }],
			}));
			await compare({
				name: 'mcp_portal_call',
				arguments: z.record(z.string(), z.unknown()).parse(portalRead('isError').arguments),
			});
			harness.fixture.setBrokenCalls(true);
			await compare({
				name: 'mcp_portal_call',
				arguments: z.record(z.string(), z.unknown()).parse(portalRead('broken-stream').arguments),
			});
			await harness.fixture.close();
			await compare({
				name: 'mcp_portal_call',
				arguments: z.record(z.string(), z.unknown()).parse(portalRead('refused-connect').arguments),
			});
		} finally {
			await reference.close();
			await harness.close();
			clock.mockRestore();
		}
	});
}
