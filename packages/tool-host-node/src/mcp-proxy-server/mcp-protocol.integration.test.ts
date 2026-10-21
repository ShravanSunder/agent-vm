import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

describe('Node MCP 2026-07-28 wire boundary', () => {
	it('refuses a real SDK v1.29 initialize before any effect', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const host = await startNodeHost({
			configPath,
			secrets: {
				resolve: async (secret): Promise<string> =>
					secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
						? secretCanary
						: headerCanary,
			},
		});
		const client = new Client({ name: 'real-v1-control', version: '1.0.0' });
		const replies: { readonly status: number; readonly body: unknown }[] = [];
		try {
			if (host.http === undefined) throw new Error('Missing HTTP listener');
			const transport = new StreamableHTTPClientTransport(host.http.endpoint, {
				requestInit: { headers: { authorization: 'Bearer credential-a' } },
				fetch: async (input, init): Promise<Response> => {
					const response = await fetch(input, init);
					const wire = await response.clone().text();
					const json =
						wire.startsWith('event:') || wire.startsWith('data:')
							? wire
									.split('\n')
									.find((line) => line.startsWith('data:'))
									?.slice(5)
									.trim()
							: wire;
					replies.push({ status: response.status, body: json ? JSON.parse(json) : null });
					return response;
				},
			});
			const candidate: unknown = transport;
			if (!isTransport(candidate)) throw new Error('Missing SDK transport');
			const connected = await client.connect(candidate).then(
				() => 'connected',
				() => 'refused',
			);
			expect(replies[0]).toMatchObject({ status: 400, body: { error: { code: -32022 } } });
			expect(replies[0]).toMatchObject({
				body: { error: { data: { supported: ['2026-07-28'] } } },
			});
			expect(connected).toBe('refused');
			expect(alpha.effects).toHaveLength(0);
			expect(beta.effects).toHaveLength(0);
		} finally {
			await client.close();
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});
});

function isTransport(
	value: unknown,
): value is import('@modelcontextprotocol/sdk/shared/transport.js').Transport {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'send' in value &&
		typeof value.send === 'function' &&
		'close' in value &&
		typeof value.close === 'function'
	);
}

it('validates modern metadata and headers before dispatch and ignores arbitrary session IDs', async () => {
	const directory = await fixtureDirectory();
	const alpha = await startControlledProvider('alpha');
	const beta = await startControlledProvider('beta');
	const configPath = await writeFixtureConfig(
		fixtureConfig(directory, [alpha.url, beta.url]),
		directory,
	);
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
		if (host.http === undefined) throw new Error('Missing HTTP listener');
		const endpoint = host.http.endpoint;
		const meta = { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} };
		const call = {
			jsonrpc: '2.0',
			id: 11,
			method: 'tools/call',
			params: {
				name: 'mcp_portal_call',
				arguments: {
					calls: [{ id: 'valid', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } }],
				},
				_meta: meta,
			},
		};
		const headers: Record<string, string> = {
			authorization: 'Bearer credential-a',
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': 'tools/call',
			'Mcp-Name': 'mcp_portal_call',
		};
		await Promise.all(
			['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name'].flatMap((field) =>
				[undefined, 'wrong'].map(async (value) => {
					const changed = { ...headers };
					if (value === undefined) delete changed[field];
					else changed[field] = value;
					const response = await fetch(endpoint, {
						method: 'POST',
						headers: changed,
						body: JSON.stringify(call),
					});
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({ error: { code: -32020 } });
				}),
			),
		);
		await Promise.all(
			[undefined, 'wrong'].map(async (name) => {
				const resourceHeaders = {
					...headers,
					'Mcp-Method': 'resources/read',
					...(name === undefined ? {} : { 'Mcp-Name': name }),
				};
				if (name === undefined) delete resourceHeaders['Mcp-Name'];
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: resourceHeaders,
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 10,
						method: 'resources/read',
						params: { uri: 'https://artifact.invalid/caller-only', _meta: meta },
					}),
				});
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ error: { code: -32020 } });
			}),
		);
		const malformed = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify({ ...call, params: { ...call.params, _meta: undefined } }),
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: { code: -32602 } });
		await Promise.all(
			['GET', 'DELETE'].map(async (method) => {
				const response = await fetch(endpoint, { method, headers });
				expect(response.status).toBe(405);
				expect(response.headers.has('mcp-session-id')).toBe(false);
				await response.text();
			}),
		);
		expect(alpha.effects).toHaveLength(0);
		async function validSession(session: string, index: number): Promise<void> {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { ...headers, 'Mcp-Session-Id': session },
				body: JSON.stringify({
					...call,
					params: {
						...call.params,
						arguments: {
							calls: [
								{
									id: `valid-${index}`,
									namespace: 'alpha',
									toolName: 'read',
									arguments: { value: 42 },
								},
							],
						},
					},
				}),
			});
			expect(response.status).toBe(200);
			expect(response.headers.has('mcp-session-id')).toBe(false);
			expect(
				decodedResult(z.object({ result: z.unknown() }).parse(await response.json()).result).ok,
			).toBe(true);
			expect(alpha.effects).toHaveLength(index + 1);
		}
		await validSession('arbitrary', 0);
		await validSession('changed', 1);
		await Promise.all(
			['server/discover', 'tools/list'].map(async (method) => {
				const noName: Record<string, string> = { ...headers, 'Mcp-Method': method };
				delete noName['Mcp-Name'];
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: noName,
					body: JSON.stringify({ jsonrpc: '2.0', id: 12, method, params: { _meta: meta } }),
				});
				expect(response.status).toBe(200);
				const body: unknown = await response.json();
				expect(body).toMatchObject({ result: { cacheScope: 'private', ttlMs: 60_000 } });
				if (method === 'server/discover') expect(JSON.stringify(body)).toContain('2026-07-28');
			}),
		);
	} finally {
		await host.retire();
		await Promise.all([alpha.close(), beta.close()]);
	}
});
