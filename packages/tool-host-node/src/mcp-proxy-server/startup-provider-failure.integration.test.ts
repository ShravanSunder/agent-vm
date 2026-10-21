import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	decodedResult,
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	successfulOutput,
	writeFixtureConfig,
	type ControlledProvider,
} from '#node-host/test-fixtures/node-host-fixture';

it('starts with two healthy providers, reports the third, refuses incomplete direct listing, and discovers recovery on the next request', async ({
	onTestFinished,
}) => {
	let now = Date.now();
	const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
	onTestFinished(() => {
		clock.mockRestore();
	});
	const directory = await fixtureDirectory();
	const alpha = await startControlledProvider('alpha');
	const beta = await startControlledProvider('beta');
	const reserved = await startControlledProvider('gamma');
	const gammaUrl = reserved.url;
	await reserved.close();
	let recovered: ControlledProvider | undefined;
	const config = fixtureConfig(directory, [alpha.url, beta.url]);
	const provider = config.mcp.providers.alpha;
	const policy = config.profiles['profile-a']?.profile.namespaces.alpha;
	if (
		provider === undefined ||
		provider.transport.kind !== 'streamable-http' ||
		policy === undefined
	)
		throw new Error('Missing fixture inputs');
	config.mcp.providers.gamma = {
		...provider,
		namespace: 'gamma',
		transport: { ...provider.transport, url: gammaUrl },
	};
	const profile = config.profiles['profile-a'];
	if (profile === undefined) throw new Error('Missing profile');
	profile.profile.namespaces.beta = policy;
	profile.profile.namespaces.gamma = policy;
	const configPath = await writeFixtureConfig(config, directory);
	const host = await startNodeHost({
		configPath,
		secrets: {
			resolve: async (secret): Promise<string> =>
				secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
					? secretCanary
					: headerCanary,
		},
	}).catch(async (error: unknown) => {
		await Promise.all([alpha.close(), beta.close()]);
		throw error;
	});
	try {
		if (host.http === undefined) throw new Error('Missing live listener');
		expect(alpha.listings).toEqual(['alpha']);
		expect(beta.listings).toEqual(['beta']);
		const connection = await connectClient(host.http.endpoint, 'credential-a');
		try {
			expect((await connection.client.listTools()).tools).toHaveLength(4);
			const list = await connection.client.callTool({
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'before' }] },
			});
			const before = JSON.stringify(decodedResult(list));
			expect(before).toContain('gamma');
			expect(before).toContain('alpha');
			expect(before).toContain('beta');
			const calls = await connection.client.callTool({
				name: 'mcp_portal_call',
				arguments: {
					calls: ['alpha', 'beta'].map((namespace) => ({
						id: namespace,
						namespace,
						toolName: 'read',
						arguments: { value: 42 },
					})),
				},
			});
			expect(decodedResult(calls)).toMatchObject({ ok: true });
			expect(alpha.effects).toHaveLength(1);
			expect(beta.effects).toHaveLength(1);
			const directUrl = new URL(host.http.endpoint);
			directUrl.searchParams.set('tools', 'direct');
			const body = {
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/list',
				params: {
					_meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} },
				},
			};
			const headers = {
				authorization: 'Bearer credential-a',
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/list',
			};
			const refused = await fetch(directUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});
			expect(refused.status).toBe(503);
			const refusal = await refused.text();
			expect(JSON.parse(refusal)).toMatchObject({
				ok: false,
				error: { kind: 'catalog_preparation_failed', failedNamespaces: ['gamma'] },
			});
			expect(refusal).not.toContain(secretCanary);
			expect(refusal).not.toContain('127.0.0.1');
			// Protocol validation still wins over catalog preparation on a malformed request.
			const { ['Mcp-Method']: removed, ...missingMethod } = headers;
			expect(removed).toBe('tools/list');
			const malformed = await fetch(directUrl, {
				method: 'POST',
				headers: missingMethod,
				body: JSON.stringify(body),
			});
			expect(malformed.status).toBe(400);
			expect(await malformed.json()).toMatchObject({ error: { code: -32020 } });
			const missingMeta = await fetch(directUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify({ ...body, params: {} }),
			});
			expect(missingMeta.status).toBe(400);
			expect(await missingMeta.json()).toMatchObject({ error: { code: -32602 } });
			const legacy = await fetch(directUrl, {
				method: 'POST',
				headers: { ...headers, 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Method': 'initialize' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 5,
					method: 'initialize',
					params: {
						protocolVersion: '2025-06-18',
						capabilities: {},
						clientInfo: { name: 'legacy', version: '1' },
					},
				}),
			});
			expect(legacy.status).toBe(400);
			expect(await legacy.json()).toMatchObject({ error: { code: -32022 } });

			recovered = await startControlledProvider('gamma', undefined, Number(new URL(gammaUrl).port));
			const recoveredResponse = await fetch(directUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});
			expect(recoveredResponse.status).toBe(200);
			const listed = z
				.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
				.parse(await recoveredResponse.json());
			expect(listed.result.tools.some((tool) => tool.name.startsWith('gamma__read__'))).toBe(true);
			expect(recovered.listings).toEqual(['gamma']);
			expect(alpha.listings).toEqual(['alpha']);
			expect(beta.listings).toEqual(['beta']);
			const after = await connection.client.callTool({
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'after' }] },
			});
			expect(JSON.stringify(decodedResult(after))).toContain('gamma');
			expect(recovered.listings).toHaveLength(1);
			now += 59999;
			await connection.client.callTool({
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'cached' }] },
			});
			expect(alpha.listings).toHaveLength(1);
			expect(beta.listings).toHaveLength(1);
			expect(recovered.listings).toHaveLength(1);
			recovered.setDiscoveryFailure(true);
			now += 1;
			const stale = await connection.client.callTool({
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'stale' }] },
			});
			const retained = JSON.stringify(decodedResult(stale));
			expect(retained).toContain('gamma');
			expect(decodedResult(stale)).toMatchObject({
				diagnostics: expect.arrayContaining([expect.objectContaining({ namespace: 'gamma' })]),
			});
			expect(successfulOutput(stale, 'stale')).toMatchObject({
				namespaces: expect.arrayContaining(['gamma']),
				tools: expect.arrayContaining([
					expect.objectContaining({ namespace: 'gamma', toolName: 'read' }),
				]),
			});
			expect(alpha.listings).toHaveLength(2);
			expect(beta.listings).toHaveLength(2);
			const retainedDirect = await fetch(directUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});
			expect(retainedDirect.status).toBe(200);
			const directCatalog = z
				.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
				.parse(await retainedDirect.json());
			expect(directCatalog.result.tools.map((tool) => tool.name)).toEqual(
				listed.result.tools.map((tool) => tool.name),
			);
			const gammaRead = directCatalog.result.tools.find((tool) =>
				tool.name.startsWith('gamma__read__'),
			);
			if (gammaRead === undefined) throw new Error('Missing retained gamma tool');
			const direct = await connectClient(directUrl, 'credential-a');
			try {
				const dispatched = await direct.client.callTool({
					name: gammaRead.name,
					arguments: { value: 55 },
				});
				expect(decodedResult(dispatched)).toMatchObject({ ok: true });
				expect(recovered.effects.map((effect) => effect.arguments)).toEqual([{ value: 55 }]);
			} finally {
				await direct.client.close();
			}
			const listingsBeforeRecovery = recovered.listings.length;
			recovered.setDiscoveryFailure(false);
			const refreshed = await connection.client.callTool({
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'refreshed' }] },
			});
			expect(decodedResult(refreshed)).toMatchObject({ diagnostics: [] });
			expect(recovered.listings).toHaveLength(listingsBeforeRecovery + 1);
			expect(alpha.listings).toHaveLength(2);
			expect(beta.listings).toHaveLength(2);
		} finally {
			await connection.client.close();
		}
	} finally {
		await host.retire();
		await Promise.all([alpha.close(), beta.close(), recovered?.close()]);
	}
});
