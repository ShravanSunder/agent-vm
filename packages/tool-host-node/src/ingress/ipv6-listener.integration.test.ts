import { request as httpRequest } from 'node:http';

import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
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
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

// The pinned Node fetch ignores a supplied Host header; use a real HTTP request for these controls.
function postMcpRequest(
	endpoint: URL,
	headers: Readonly<Record<string, string>>,
	body: string,
): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			endpoint,
			{ method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } },
			(response) => {
				const chunks: string[] = [];
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
					chunks.push(chunk);
				});
				response.once('error', reject);
				response.once('end', () => {
					resolve({ status: response.statusCode ?? 0, body: chunks.join('') });
				});
			},
		);
		request.once('error', reject);
		request.end(body);
	});
}

it.each(['::1', '[::1]'])(
	'serves real IPv6 loopback with configured allowedHost %s and rejects hostile Host headers',
	async (allowedHost) => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		if (config.listener.kind !== 'http') throw new Error('Missing HTTP listener config');
		config.listener.hostname = '::1';
		config.listener.allowedHosts = [allowedHost];
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
			if (host.http === undefined) throw new Error('Missing IPv6 listener');
			expect(host.http.endpoint.hostname).toBe('[::1]');
			const requestHeaders = {
				authorization: 'Bearer credential-a',
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'mcp_portal_call',
			};
			const callBody = JSON.stringify({
				jsonrpc: '2.0',
				id: 9,
				method: 'tools/call',
				params: {
					name: 'mcp_portal_call',
					arguments: {
						calls: [{ id: 'ipv6', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } }],
					},
					_meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} },
				},
			});
			const endpoint = host.http.endpoint;
			const [hostile, malformed] = await Promise.all(
				['[::2]', '::1'].map(async (hostHeader) =>
					postMcpRequest(endpoint, { ...requestHeaders, host: hostHeader }, callBody),
				),
			);
			process.stdout.write(
				JSON.stringify({
					allowedHost,
					rejectedStatuses: [hostile?.status, malformed?.status],
					effectsBeforeControl: alpha.effects.length,
				}) + '\n',
			);
			expect(hostile?.status).toBe(400);
			expect(malformed?.status).toBe(400);
			expect(alpha.effects).toHaveLength(0);
			const client = await connectClient(host.http.endpoint, 'credential-a');
			try {
				expect((await client.client.listTools()).tools).toHaveLength(4);
				const control = await postMcpRequest(endpoint, requestHeaders, callBody);
				expect(control.status).toBe(200);
				const result = z.object({ result: z.unknown() }).parse(JSON.parse(control.body));
				expect(decodedResult(result.result)).toMatchObject({ ok: true });
				expect(alpha.effects).toHaveLength(1);
			} finally {
				await client.client.close();
			}
		} finally {
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	},
);
