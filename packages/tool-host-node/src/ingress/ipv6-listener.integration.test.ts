import { expect, it } from 'vitest';

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
			const [hostile, malformed] = await Promise.all(
				['[::2]', '::1'].map(async (hostHeader) =>
					fetch(host.http?.endpoint ?? '', {
						method: 'POST',
						headers: {
							host: hostHeader,
							authorization: 'Bearer credential-a',
							'content-type': 'application/json',
						},
						body: '{}',
					}),
				),
			);
			expect(hostile?.status).toBe(400);
			expect(malformed?.status).toBe(400);
			expect(alpha.effects).toHaveLength(0);
			const client = await connectClient(host.http.endpoint, 'credential-a');
			try {
				expect((await client.client.listTools()).tools).toHaveLength(4);
				const result = await client.client.callTool({
					name: 'mcp_portal_call',
					arguments: {
						calls: [{ id: 'ipv6', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } }],
					},
				});
				expect(decodedResult(result)).toMatchObject({ ok: true });
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
