import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { startLegacyProxyReference } from '#worker-host/test-fixtures/legacy-proxy-reference';
import {
	startLocalWorkerHarness,
	rpcResult,
} from '#worker-host/test-fixtures/local-worker-harness';

import { startNodeHost } from '../../tool-host-node/src/node-host-startup.js';
import { fixtureConfig } from '../../tool-host-node/src/test-fixtures/node-host-fixture.js';

for (const mode of ['direct', 'indirect'] as const)
	it(`${mode}: real Node and Worker proxy preserve08f9e426 missing-token error with zero effects`, async () => {
		const harness = await startLocalWorkerHarness();
		const reference = await startLegacyProxyReference(harness.fixture.url, mode);
		const directory = await mkdtemp(path.join(tmpdir(), '2026-10-s6-missing-approval-'));
		const config = fixtureConfig(directory, [
			`${harness.fixture.url}/mcp`,
			`${harness.fixture.url}/mcp`,
		]);
		const namespace = config.mcp.providers.alpha;
		const profile = config.profiles['profile-a'];
		const policy = profile?.profile.namespaces.alpha;
		if (namespace === undefined || profile === undefined || policy === undefined)
			throw new Error('Missing Node fixture.');
		namespace.namespace = 'same-server';
		delete profile.profile.namespaces.alpha;
		profile.profile.namespaces['same-server'] = policy;
		const configPath = path.join(directory, 'host.json');
		await writeFile(configPath, JSON.stringify(config));
		const host = await startNodeHost({
			configPath,
			secrets: { resolve: async () => 'one-secret-canary' },
			approvalKeysByAgent: new Map([['agent-a', new Uint8Array(32).fill(0x12)]]),
		});
		try {
			if (host.http === undefined) throw new Error('Missing Node listener.');
			const directName = z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse(await rpcResult(await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' })))
				.tools.find((tool) => tool.name.includes('__ask__'))?.name;
			if (directName === undefined) throw new Error('Missing native tool.');
			const request =
				mode === 'direct'
					? { name: directName, arguments: {} }
					: {
							name: 'mcp_portal_call',
							arguments: {
								calls: [{ id: 'ask', namespace: 'same-server', toolName: 'ask', arguments: {} }],
							},
						};
			const expected = await reference.client.callTool(request);
			const worker = await rpcResult(
				await harness.rpc('tools/call', request, {
					path: mode === 'direct' ? '/mcp?tools=direct' : '/mcp',
				}),
			);
			const nodeResponse = await fetch(
				new URL(mode === 'direct' ? '?tools=direct' : '', host.http.endpoint),
				{
					method: 'POST',
					headers: {
						authorization: 'Bearer credential-a',
						'content-type': 'application/json',
						'MCP-Protocol-Version': '2026-07-28',
						'Mcp-Method': 'tools/call',
						'Mcp-Name': request.name,
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'tools/call',
						params: {
							...request,
							_meta: {
								'io.modelcontextprotocol/protocolVersion': '2026-07-28',
								'io.modelcontextprotocol/clientCapabilities': {},
							},
						},
					}),
				},
			);
			expect(nodeResponse.status).toBe(200);
			const node = z
				.object({ result: z.record(z.string(), z.unknown()) })
				.parse(await nodeResponse.json()).result;
			for (const actual of [worker, node]) {
				const { _meta: metadata, resultType, ...surface } = actual;
				expect(metadata).toBeDefined();
				expect(resultType).toBe('complete');
				expect(surface).toEqual(expected);
			}
			expect(JSON.stringify(expected)).toContain('approval_token_missing');
			expect(harness.fixture.calls).toHaveLength(0);
		} finally {
			await host.retire();
			await reference.close();
			await harness.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
