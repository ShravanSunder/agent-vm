import { request as httpRequest } from 'node:http';

import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { nodeHostConfigSchema } from '#node-host/configuration/node-host-config';
import { startNodeHost, type RunningNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	decodedResult,
	fixtureContextRef,
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
function endpoint(host: RunningNodeHost): URL {
	if (host.http === undefined) throw new Error('Missing HTTP host');
	const address = new URL(host.http.endpoint);
	if (host.composition.config.exposure === 'catalog') address.searchParams.set('tools', 'direct');
	return address;
}
const permittedCall = {
	name: 'mcp_portal_call',
	arguments: {
		calls: [{ id: 'overlap', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } }],
	},
};

describe('Node host real admission and preparation races', () => {
	for (const exposure of ['compact', 'catalog'] as const) {
		it(`${exposure}: refuses a formerly permitted reference after trusted assignment changes and host reconstruction`, async () => {
			const directory = await fixtureDirectory();
			const alpha = await startControlledProvider('alpha');
			const beta = await startControlledProvider('beta');
			const config = fixtureConfig(directory, [alpha.url, beta.url], exposure);
			const configPath = await writeFixtureConfig(config, directory);
			const original = await startNodeHost({ configPath, secrets });
			const old = await connectClient(endpoint(original), 'credential-a');
			const call =
				exposure === 'compact'
					? permittedCall
					: {
							name: 'alpha__read__151160dc30',
							arguments: { value: 42 },
							_meta: { 'tool-portal/operation-item': 'overlap' },
						};
			try {
				await old.client.callTool(call);
				expect(alpha.effects).toHaveLength(1);
			} finally {
				await old.client.close();
				await original.retire();
			}
			const own = config.profiles['profile-a'];
			const policy = own?.profile.namespaces.alpha;
			if (own === undefined || policy === undefined) throw new Error('Missing fixture policy');
			const changed = nodeHostConfigSchema.parse({
				...config,
				revision: { ...config.revision, revision: 'v2' },
				profiles: {
					...config.profiles,
					'profile-a': {
						...own,
						revision: { ...own.revision, revision: 'v2' },
						profile: {
							...own.profile,
							namespaces: {
								alpha: { ...policy, tools: { allow: '*', deny: ['read', 'hidden', 'blocked'] } },
							},
						},
					},
				},
			});
			await writeFixtureConfig(changed, directory);
			const replacement = await startNodeHost({ configPath, secrets });
			const current = await connectClient(endpoint(replacement), 'credential-a');
			try {
				expect(await current.client.callTool(call)).toMatchObject({ isError: true });
				expect(alpha.effects).toHaveLength(1);
			} finally {
				await current.client.close();
				await replacement.retire();
				await alpha.close();
				await beta.close();
			}
		});
	}
	it('refuses registered hidden and approval-only backend effects at actual ingress', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const host = await startNodeHost({ configPath, secrets });
		const a = await connectClient(endpoint(host), 'credential-a');
		try {
			await a.client.callTool(permittedCall);
			await a.client.callTool({
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'hidden-negative',
							namespace: 'alpha',
							toolName: 'hidden',
							arguments: { value: 43 },
						},
						{
							id: 'approval-negative',
							namespace: 'alpha',
							toolName: 'ask',
							arguments: { value: 44 },
						},
					],
				},
			});
			expect(
				alpha.effects.map((effect) => ({ name: effect.name, arguments: effect.arguments })),
			).toEqual([{ name: 'read', arguments: { value: 42 } }]);
		} finally {
			await a.client.close();
			await host.retire();
			await alpha.close();
			await beta.close();
		}
	});
	it('permits a mixed batch sibling, then refuses work after the in-memory authority closes', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({ configPath, secrets });
		const client = await connectClient(endpoint(host), 'credential-a');
		try {
			const mixed = await client.client.callTool({
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{ id: 'denied', namespace: 'alpha', toolName: 'hidden', arguments: { value: 0 } },
						{
							id: 'permitted',
							namespace: 'alpha',
							toolName: 'read',
							arguments: { value: 7, profile: 'legitimate argument' },
						},
					],
				},
			});
			expect(decodedResult(mixed)).toMatchObject({
				ok: false,
				results: { denied: { ok: false }, permitted: { ok: true } },
			});
			expect(alpha.effects.map((effect) => effect.arguments)).toEqual([
				{ value: 7, profile: 'legitimate argument' },
			]);
			expect(
				await host.composition.operations.lookup({
					version: 'tool-operation-v1',
					key: { authority: config.authority, principal: 'agent-a', item: 'permitted' },
					verifiedContextRef: fixtureContextRef(config),
				}),
			).toEqual({ kind: 'not-found' });
			await host.composition.close();
			await expect(client.client.callTool(permittedCall)).rejects.toThrow();
			expect(alpha.effects).toHaveLength(1);
		} finally {
			await client.client.close();
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});

	it('rechecks credentials after a held body, drains old requests, and admits the rotated credential', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({ configPath, secrets });
		try {
			if (host.http === undefined) throw new Error('Missing HTTP listener');
			const body = JSON.stringify({
				jsonrpc: '2.0',
				id: 88,
				method: 'tools/call',
				params: {
					...permittedCall,
					_meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} },
				},
			});
			let finish: (() => void) | undefined;
			const reply = new Promise<number>((resolve, reject) => {
				const request = httpRequest(
					endpoint(host),
					{
						method: 'POST',
						headers: {
							authorization: 'Bearer credential-a',
							'content-type': 'application/json',
							accept: 'application/json, text/event-stream',
							'content-length': Buffer.byteLength(body),
							'MCP-Protocol-Version': '2026-07-28',
							'Mcp-Method': 'tools/call',
							'Mcp-Name': 'mcp_portal_call',
						},
					},
					(response) => {
						response.resume();
						response.once('end', () => resolve(response.statusCode ?? 0));
					},
				);
				request.once('error', reject);
				request.write(body.slice(0, 1));
				finish = () => request.end(body.slice(1));
			});
			// A completed request on the same listener is an event barrier after the held request's headers.
			const probe = await connectClient(endpoint(host), 'credential-a');
			await probe.client.close();
			const rotated = {
				...config.auth,
				credentials: config.auth.credentials.map((credential) => ({
					...credential,
					credentialVersion: 2,
					bearerToken: `${credential.bearerToken}-rotated`,
				})),
			};
			const rotation = host.http.activateCredentialSet(rotated);
			finish?.();
			expect(await reply).toBe(401);
			await rotation;
			await expect(connectClient(endpoint(host), 'credential-a')).rejects.toThrow();
			const fresh = await connectClient(endpoint(host), 'credential-a-rotated');
			try {
				expect(decodedResult(await fresh.client.callTool(permittedCall))).toMatchObject({
					ok: true,
				});
			} finally {
				await fresh.client.close();
			}
			expect(alpha.effects).toHaveLength(1);
		} finally {
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});

	it('drains a real in-flight provider response before retirement completes', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const held = alpha.holdCalls();
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const host = await startNodeHost({ configPath, secrets });
		const client = await connectClient(endpoint(host), 'credential-a');
		try {
			const pending = client.client.callTool(permittedCall);
			await held.entered;
			let retired = false;
			const retirement = host.retire().then(() => {
				retired = true;
			});
			expect(retired).toBe(false);
			held.release();
			expect(decodedResult(await pending)).toMatchObject({ ok: true });
			await retirement;
			expect(retired).toBe(true);
			expect(alpha.effects).toHaveLength(1);
		} finally {
			held.release();
			await client.client.close();
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});

	it('refuses duplicate direct names and refuses startup if a configured server cannot list', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		alpha.duplicateDiscovery();
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url], 'catalog'),
			directory,
		);
		const host = await startNodeHost({ configPath, secrets });
		const client = await connectClient(endpoint(host), 'credential-a');
		try {
			await expect(client.client.listTools()).rejects.toThrow();
			expect(alpha.effects).toHaveLength(0);
		} finally {
			await client.client.close();
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
		await expect(startNodeHost({ configPath, secrets })).rejects.toThrow();
	});
});
