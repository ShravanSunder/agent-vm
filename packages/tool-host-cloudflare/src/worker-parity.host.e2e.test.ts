import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { startLegacyProxyReference } from '#worker-host/test-fixtures/legacy-proxy-reference';
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
			}): Promise<void> => {
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
