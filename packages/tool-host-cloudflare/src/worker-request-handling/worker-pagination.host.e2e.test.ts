import { organizationConfigurationSchema } from '@agent-collaboration/tool-host-core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { organizationConfigurations } from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	startLocalWorkerHarness,
	rpcResult,
	portalRead,
} from '#worker-host/test-fixtures/local-worker-harness';

it('pages170 large schemas under1MiB and serves both real SDKv2 client cases together', async () => {
	const harness = await startLocalWorkerHarness({
		setup: (fixture) =>
			fixture.setCatalog(
				Array.from({ length: 170 }, (_, index) => ({
					name: index === 0 ? 'read' : `large-${String(index)}`,
					inputSchema: {
						type: 'object',
						description: 'schema'.repeat(4500),
						properties: { value: {} },
						additionalProperties: true,
					},
				})),
			),
		configurations: (url) => {
			const configs = z
				.record(z.string(), organizationConfigurationSchema)
				.parse(organizationConfigurations(url));
			for (const config of Object.values(configs))
				for (const profile of Object.values(config.portal.profiles))
					for (const policy of Object.values(profile.namespaces)) {
						policy.tools = { allow: '*', deny: [] };
						policy.calls = {
							withoutApproval: { allow: '*', deny: [] },
							requiresApproval: { allow: [], deny: [] },
						};
					}
			return configs;
		},
	});
	const clients = [
		new Client(
			{ name: 'local-direct', version: '2.3.1' },
			{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
		),
		new Client(
			{ name: 'local-default', version: '2.3.1' },
			{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
		),
	];
	try {
		await rpcResult(await harness.rpc('server/discover'));
		expect(harness.fixture.discoveryCredentials).toHaveLength(1);
		const pageBytes: number[] = [];
		const names: string[] = [];
		let cursor: string | undefined;
		do {
			const response = await harness.rpc('tools/list', cursor === undefined ? {} : { cursor }, {
				path: '/mcp?tools=direct',
			});
			const page = await rpcResult(response);
			const { _meta: metadata, resultType, ...enginePage } = page;
			expect(metadata).toBeDefined();
			expect(resultType).toBe('complete');
			const bytes = new TextEncoder().encode(JSON.stringify(enginePage)).byteLength;
			pageBytes.push(bytes);
			expect(bytes).toBeLessThanOrEqual(1024 * 1024);
			const parsed = z
				.object({
					tools: z.array(z.object({ name: z.string() })),
					nextCursor: z.string().optional(),
					cacheScope: z.literal('private'),
					ttlMs: z.literal(60000),
				})
				.parse(page);
			names.push(...parsed.tools.map((tool) => tool.name));
			cursor = parsed.nextCursor;
		} while (cursor !== undefined);
		expect(names).toHaveLength(174);
		expect(new Set(names).size).toBe(174);
		expect(pageBytes.length).toBeGreaterThan(4);
		await Promise.all(
			clients.map(async (client, index) =>
				client.connect(
					new StreamableHTTPClientTransport(
						new URL(
							`http://${harness.worker.address}:${String(harness.worker.port)}/mcp${index === 0 ? '?tools=direct' : ''}`,
						),
						{
							requestInit: {
								headers: { authorization: `Bearer ${harness.token}`, connection: 'close' },
							},
						},
					),
				),
			),
		);
		const lists = await Promise.all(clients.map(async (client) => client.listTools()));
		expect(lists[0]?.tools).toHaveLength(174);
		expect(lists[1]?.tools).toHaveLength(4);
		await Promise.all(
			clients.map(async (client) => {
				await client.callTool({
					name: 'mcp_portal_call',
					arguments: z.record(z.string(), z.unknown()).parse(portalRead('one').arguments),
				});
				await client.callTool({
					name: 'mcp_portal_call',
					arguments: z.record(z.string(), z.unknown()).parse(portalRead('two').arguments),
				});
			}),
		);
		expect(harness.fixture.calls).toHaveLength(4);
		expect(harness.fixture.discoveryCredentials).toHaveLength(1);
		expect((await clients[0]?.listTools())?.tools).toHaveLength(174);
		process.stdout.write(
			`${JSON.stringify({ catalogTools: 170, offeredTools: names.length, serializedEnginePageBytes: pageBytes, sdkClient: '2.3.1', deferralContextProof: 'not observed; no model traffic' })}\n`,
		);
	} finally {
		await Promise.all(clients.map(async (client) => client.close()));
		await harness.close();
	}
});
