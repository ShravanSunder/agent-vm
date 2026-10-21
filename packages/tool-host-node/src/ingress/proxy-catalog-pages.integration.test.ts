import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { nodeHostConfigSchema } from '#node-host/configuration/node-host-config';
import { startNodeHost } from '#node-host/node-host-startup';
import {
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

it('serves all 170 large tools and four search tools in private result pages below 1 MiB, keeping address cases independent', async () => {
	const directory = await fixtureDirectory();
	const catalog = Array.from({ length: 170 }, (_, index) => ({
		name: `read_${String(index).padStart(3, '0')}`,
		description: 'd'.repeat(26_800),
		inputSchema: { type: 'object' as const, properties: { value: { type: 'integer' } } },
	}));
	const alpha = await startControlledProvider('alpha', catalog);
	const beta = await startControlledProvider('beta');
	const initial = fixtureConfig(directory, [alpha.url, beta.url]);
	const own = initial.profiles['profile-a'];
	const policy = own?.profile.namespaces.alpha;
	if (own === undefined || policy === undefined) throw new Error('Missing profile fixture');
	const config = nodeHostConfigSchema.parse({
		...initial,
		profiles: {
			...initial.profiles,
			'profile-a': {
				...own,
				profile: {
					...own.profile,
					namespaces: {
						alpha: {
							...policy,
							tools: { allow: '*', deny: [] },
							calls: {
								kind: 'selectors',
								withoutApproval: { allow: '*', deny: [] },
								requiresApproval: { allow: [], deny: [] },
							},
						},
					},
				},
			},
		},
	});
	const configPath = await writeFixtureConfig(config, directory);
	const host = await startNodeHost({
		configPath,
		secrets: {
			resolve: async (secret): Promise<string> =>
				secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
					? secretCanary
					: headerCanary,
		},
	});
	try {
		if (host.http === undefined) throw new Error('Missing listener');
		const endpoint = host.http.endpoint;
		const pageSchema = z.object({
			result: z.object({
				tools: z.array(z.object({ name: z.string() })),
				nextCursor: z.string().optional(),
				cacheScope: z.literal('private'),
				ttlMs: z.literal(60_000),
			}),
		});
		const pageBytes: number[] = [];
		async function page(
			query: string,
			cursor?: string,
		): Promise<z.infer<typeof pageSchema>['result']> {
			const response = await fetch(`${endpoint.href}${query}`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer credential-a',
					accept: 'application/json, text/event-stream',
					'content-type': 'application/json',
					'MCP-Protocol-Version': '2026-07-28',
					'Mcp-Method': 'tools/list',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: {
						...(cursor === undefined ? {} : { cursor }),
						_meta: {
							[PROTOCOL_VERSION_META_KEY]: '2026-07-28',
							[CLIENT_CAPABILITIES_META_KEY]: {},
						},
					},
				}),
			});
			expect(response.status).toBe(200);
			const wire = await response.text();
			const bytes = Buffer.byteLength(wire);

			if (query) pageBytes.push(bytes);
			const decoded: unknown = JSON.parse(wire);
			const result = pageSchema.parse(decoded).result;
			const originalResult = z.object({ result: z.unknown() }).parse(decoded).result;
			expect(Buffer.byteLength(JSON.stringify(originalResult))).toBeLessThanOrEqual(1024 * 1024);
			return result;
		}
		async function collect(cursor?: string): Promise<string[]> {
			const current = await page('?tools=direct', cursor);
			return [
				...current.tools.map((tool) => tool.name),
				...(current.nextCursor === undefined ? [] : await collect(current.nextCursor)),
			];
		}
		const [direct, indirect] = await Promise.all([collect(), page('')]);
		expect(direct).toHaveLength(174);
		expect(new Set(direct).size).toBe(174);
		expect(indirect.tools.map((tool) => tool.name)).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect(await page('')).toEqual(indirect);
		expect(pageBytes.length).toBeGreaterThan(1);
		expect(alpha.listings).toEqual(['alpha']);
		process.stdout.write(
			JSON.stringify({
				catalogTools: catalog.length,
				offeredTools: direct.length,
				pageBytes,
				totalWireBytes: pageBytes.reduce((sum, bytes) => sum + bytes, 0),
			}) + '\n',
		);
	} finally {
		await host.retire();
		await Promise.all([alpha.close(), beta.close()]);
	}
});
