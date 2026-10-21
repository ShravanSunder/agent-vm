import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	decodedResult,
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

const secrets = {
	resolve: async (secret: { readonly source: string; readonly name?: string }): Promise<string> =>
		secret.name === 'PROVIDER_SECRET' ? secretCanary : headerCanary,
};
const meta = { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} };
const rpcReply = z.object({
	error: z.object({ code: z.number() }).optional(),
	result: z.record(z.string(), z.unknown()).optional(),
});

describe('Node process startup and long-lived stdio connection', () => {
	it('refuses old and malformed openings while keeping the same stdio connection alive', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		const input = new PassThrough();
		const output = new PassThrough();
		const lines = createInterface({ input: output });
		const configPath = await writeFixtureConfig(
			{ ...config, listener: { kind: 'stdio', agentId: 'agent-a' } },
			directory,
		);
		const host = await startNodeHost({ configPath, secrets, input, output });
		async function exchange(body: unknown): Promise<z.infer<typeof rpcReply>> {
			const received = once(lines, 'line');
			input.write(`${JSON.stringify(body)}\n`);
			const [line] = await received;
			return rpcReply.parse(JSON.parse(z.string().parse(line)));
		}
		try {
			expect(
				(
					await exchange({
						jsonrpc: '2.0',
						id: 1,
						method: 'initialize',
						params: {
							protocolVersion: '2025-11-25',
							capabilities: {},
							clientInfo: { name: 'v1-wire', version: '1' },
						},
					})
				).error?.code,
			).toBe(-32022);
			expect(
				(await exchange({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).error?.code,
			).toBe(-32022);
			expect(
				(
					await exchange({
						jsonrpc: '2.0',
						id: 3,
						method: 'tools/list',
						params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } },
					})
				).error?.code,
			).toBe(-32602);
			const valid = await exchange({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/list',
				params: { _meta: meta },
			});
			expect(valid.result).toMatchObject({
				ttlMs: 60_000,
				cacheScope: 'private',
				tools: expect.arrayContaining([expect.objectContaining({ name: 'mcp_portal_call' })]),
			});
			expect(
				decodedResult(
					(
						await exchange({
							jsonrpc: '2.0',
							id: 5,
							method: 'tools/call',
							params: {
								name: 'mcp_portal_call',
								arguments: {
									calls: [
										{
											id: 'stdio-control',
											namespace: 'alpha',
											toolName: 'read',
											arguments: { value: 42 },
										},
									],
								},
								_meta: meta,
							},
						})
					).result,
				).ok,
			).toBe(true);
			expect(alpha.effects).toHaveLength(1);
			expect(alpha.listings).toHaveLength(1);
		} finally {
			await host.retire();
			lines.close();
			input.destroy();
			output.destroy();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});

	it('finishes one organization listing before admitting clients, then projects both addresses without relisting', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const reservation = createServer();
		reservation.listen(0, '127.0.0.1');
		await once(reservation, 'listening');
		const address = reservation.address();
		if (address === null || typeof address === 'string')
			throw new Error('Missing reserved address');
		const port = address.port;
		await new Promise<void>((resolve, reject) =>
			reservation.close((error) => (error === undefined ? resolve() : reject(error))),
		);
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		if (config.listener.kind !== 'http') throw new Error('Missing HTTP config');
		const configPath = await writeFixtureConfig(
			{ ...config, listener: { ...config.listener, port } },
			directory,
		);
		const held = alpha.holdDiscovery();
		const starting = startNodeHost({ configPath, secrets });
		const opening = await Promise.race([
			held.entered.then(() => ({ kind: 'listing' as const })),
			starting.then((host) => ({ kind: 'serving' as const, host })),
		]);
		if (opening.kind === 'serving') {
			held.release();
			await opening.host.retire();
			await Promise.all([alpha.close(), beta.close()]);
			expect(opening.kind).toBe('listing');
			return;
		}
		const refused = connect({ host: '127.0.0.1', port });
		await expect(once(refused, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
		refused.destroy();
		held.release();
		const host = await starting;
		try {
			if (host.http === undefined) throw new Error('Missing HTTP listener');
			async function names(query: string, token = 'credential-a'): Promise<string[]> {
				const response = await fetch(`${host.http?.endpoint.href}${query}`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
						'MCP-Protocol-Version': '2026-07-28',
						'Mcp-Method': 'tools/list',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 11,
						method: 'tools/list',
						params: { _meta: meta },
					}),
				});
				expect(response.status).toBe(200);
				const bytes = await response.text();
				expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(1024 * 1024);
				return z
					.object({
						result: z.object({
							cacheScope: z.literal('private'),
							ttlMs: z.literal(60_000),
							tools: z.array(z.object({ name: z.string() })),
						}),
					})
					.parse(JSON.parse(bytes))
					.result.tools.map((tool) => tool.name);
			}
			const [direct, indirect] = await Promise.all([names('?tools=direct'), names('')]);
			expect(indirect).toEqual([
				'mcp_portal_list',
				'mcp_portal_search',
				'mcp_portal_describe',
				'mcp_portal_call',
			]);
			expect(direct).toEqual(expect.arrayContaining([...indirect, 'alpha__read__151160dc30']));
			expect(await names('')).toEqual(indirect);
			expect(await names('?tools=direct')).toEqual(direct);
			expect(await names('?tools=direct', 'credential-b')).toContain('beta__read__08da93d672');
			expect(alpha.listings).toEqual(['alpha']);
			expect(beta.listings).toEqual(['beta']);
		} finally {
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});
});
