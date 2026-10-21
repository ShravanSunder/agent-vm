import { organizationConfigurationSchema } from '@agent-collaboration/tool-host-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	organizationConfigurations,
	organizationOne,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	startLocalWorkerHarness,
	rpcResult,
	portalRead,
} from '#worker-host/test-fixtures/local-worker-harness';

it('keeps healthy tools during a startup outage, retries the failed server, and retains a complete catalog after a failed60s refresh', async () => {
	const now = Date.now();
	const harness = await startLocalWorkerHarness({
		fixedClock: now,
		setup: (fixture) => fixture.setUnavailablePath('/down', true),
		configurations: (url) => {
			const configurations = z
				.record(z.string(), organizationConfigurationSchema)
				.parse(organizationConfigurations(url));
			const config = configurations[organizationOne];
			const provider = config?.mcp.providers.fixture;
			const profile = config?.portal.profiles.one;
			const policy = profile?.namespaces['same-server'];
			if (
				config === undefined ||
				provider === undefined ||
				profile === undefined ||
				policy === undefined ||
				provider.transport.kind !== 'streamable-http'
			)
				throw new Error('Missing outage fixture.');
			config.mcp.providers.down = {
				...provider,
				namespace: 'down-server',
				transport: { ...provider.transport, url: `${url}/down` },
			};
			profile.namespaces['down-server'] = policy;
			config.mcp.providers.healthy = {
				...provider,
				namespace: 'healthy-server',
				transport: { ...provider.transport, url: `${url}/healthy` },
			};
			profile.namespaces['healthy-server'] = policy;
			return configurations;
		},
	});
	try {
		await rpcResult(await harness.rpc('server/discover'));
		const partial = await rpcResult(
			await harness.rpc('tools/call', {
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'healthy-list' }] },
			}),
		);
		const partialText = z
			.object({ content: z.tuple([z.object({ text: z.string() })]) })
			.parse(partial).content[0].text;
		const partialCore = z
			.object({
				structuredContent: z.object({
					results: z.object({
						'healthy-list': z.object({
							ok: z.literal(true),
							output: z.object({
								namespaces: z.array(z.string()),
								tools: z.array(z.object({ namespace: z.string(), toolName: z.string() })),
							}),
						}),
					}),
				}),
			})
			.parse(JSON.parse(partialText));
		const available = partialCore.structuredContent.results['healthy-list'].output;
		expect(available.namespaces).toEqual(['healthy-server', 'same-server']);
		expect(
			available.tools
				.filter((tool) => tool.toolName === 'read')
				.map((tool) => tool.namespace)
				.toSorted(),
		).toEqual(['healthy-server', 'same-server']);
		await rpcResult(await harness.rpc('tools/call', portalRead('healthy-during-outage')));
		await rpcResult(
			await harness.rpc('tools/call', {
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'second-healthy',
							namespace: 'healthy-server',
							toolName: 'read',
							arguments: { value: 'second-healthy-during-outage' },
						},
					],
				},
			}),
		);
		expect(harness.fixture.calls.map((call) => call.arguments.value)).toEqual([
			'healthy-during-outage',
			'second-healthy-during-outage',
		]);
		const incomplete = await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' });
		expect(incomplete.status).toBe(503);
		expect(await incomplete.json()).toEqual({
			ok: false,
			error: { kind: 'catalog_preparation_failed', failedNamespaces: ['down-server'] },
		});
		harness.fixture.setUnavailablePath('/down', false);
		const complete = await rpcResult(
			await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }),
		);
		expect(z.object({ tools: z.array(z.unknown()) }).parse(complete).tools).toHaveLength(10);
		const offered = z
			.object({ tools: z.array(z.object({ name: z.string() })) })
			.parse(complete)
			.tools.map((tool) => tool.name);
		expect(offered.some((name) => name.startsWith('same-server__read__'))).toBe(true);
		expect(offered.some((name) => name.startsWith('healthy-server__read__'))).toBe(true);
		expect(offered.some((name) => name.startsWith('down-server__read__'))).toBe(true);
		await rpcResult(
			await harness.rpc('tools/call', {
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'recovered',
							namespace: 'down-server',
							toolName: 'read',
							arguments: { value: 'recovered-server' },
						},
					],
				},
			}),
		);
		expect(harness.fixture.calls.at(-1)?.arguments.value).toBe('recovered-server');
		const lists = harness.fixture.discoveryCredentials.length;
		await rpcResult(await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }));
		expect(harness.fixture.discoveryCredentials).toHaveLength(lists);
		harness.fixture.setUnavailablePath('/down', true);
		const clock = await harness.worker.fetch(`/__clock?now=${String(now + 60_001)}`);
		await clock.body?.cancel();
		const retained = await rpcResult(
			await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }),
		);
		expect(retained.tools).toEqual(complete.tools);
		await rpcResult(await harness.rpc('tools/call', portalRead('healthy-after-failed-refresh')));
		expect(harness.fixture.calls).toHaveLength(4);
		harness.fixture.setUnavailablePath('/down', false);
		expect(
			(await rpcResult(await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }))).tools,
		).toEqual(complete.tools);
	} finally {
		await harness.close();
	}
});
