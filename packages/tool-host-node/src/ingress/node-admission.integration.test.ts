import { writeFile } from 'node:fs/promises';
import path from 'node:path';

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
	successfulOutput,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

const secrets = {
	resolve: async (secret: { readonly source: string; readonly name?: string }): Promise<string> =>
		secret.name === 'PROVIDER_SECRET' ? secretCanary : headerCanary,
};
function endpoint(host: RunningNodeHost): URL {
	if (host.http === undefined) throw new Error('Missing HTTP host');
	return host.http.endpoint;
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
	it('overlaps requests across two handlers while the provider effect is held; records one effect and never blindly dispatches again', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const held = alpha.holdCalls();
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const host = await startNodeHost({ configPath, secrets });
		const first = await connectClient(endpoint(host), 'credential-a');
		const second = await connectClient(endpoint(host), 'credential-a');
		try {
			const pending = first.client.callTool(permittedCall);
			await held.entered;
			expect(decodedResult(await second.client.callTool(permittedCall))).toMatchObject({
				ok: false,
				results: {
					overlap: {
						ok: false,
						error: { kind: 'ambiguous', reason: 'operation-may-have-dispatched' },
					},
				},
			});
			expect(alpha.effects).toHaveLength(1);
			held.release();
			const completed = await pending;
			expect(successfulOutput(completed, 'overlap')).toMatchObject({
				namespace: 'alpha',
				toolName: 'read',
			});
			expect(await second.client.callTool(permittedCall)).toEqual(completed);
			expect(alpha.effects).toHaveLength(1);
		} finally {
			held.release();
			await first.client.close();
			await second.client.close();
			await host.retire();
			await alpha.close();
			await beta.close();
		}
	});
	it('fails closed before effect when the real record store is unavailable; keeps a permitted sibling independent of another failed item', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({ configPath, secrets });
		const a = await connectClient(endpoint(host), 'credential-a');
		try {
			const mixed = await a.client.callTool({
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'denied-sibling',
							namespace: 'alpha',
							toolName: 'hidden',
							arguments: { value: 0 },
						},
						{
							id: 'permitted-sibling',
							namespace: 'alpha',
							toolName: 'read',
							arguments: { value: 7, profile: 'a legitimate tool argument' },
						},
					],
				},
			});
			expect(decodedResult(mixed)).toMatchObject({
				ok: false,
				results: {
					'denied-sibling': { ok: false },
					'permitted-sibling': { ok: true, output: { namespace: 'alpha', toolName: 'read' } },
				},
			});
			expect(alpha.effects.map((effect) => effect.arguments)).toEqual([
				{ value: 7, profile: 'a legitimate tool argument' },
			]);
			const known = host.composition.operations;
			expect(
				await known.lookup({
					version: 'tool-operation-v1',
					key: { authority: config.authority, principal: 'agent-a', item: 'absent' },
					verifiedContextRef: fixtureContextRef(config),
				}),
			).toEqual({ kind: 'not-found' });
		} finally {
			await a.client.close();
			await host.retire();
		}
		const blockedDirectory = await fixtureDirectory();
		const blockedConfig = fixtureConfig(blockedDirectory, [alpha.url, beta.url]);
		const blockedPath = await writeFixtureConfig(blockedConfig, blockedDirectory);
		const blocked = await startNodeHost({ configPath: blockedPath, secrets });
		await writeFile(
			path.join(blockedConfig.storeDirectory, 'tool-operations-v1'),
			'storage is unavailable',
		);
		const b = await connectClient(endpoint(blocked), 'credential-a');
		try {
			expect(decodedResult(await b.client.callTool(permittedCall))).toMatchObject({
				ok: false,
				results: {
					overlap: { ok: false, error: { kind: 'not-dispatched', reason: 'unavailable' } },
				},
			});
			expect(alpha.effects).toHaveLength(1);
		} finally {
			await b.client.close();
			await blocked.retire();
			await alpha.close();
			await beta.close();
		}
	});
	it('rejects a credential retired during pending full catalog/client construction and permits the rotated credential', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const held = alpha.holdDiscovery();
		const config = fixtureConfig(directory, [alpha.url, beta.url], 'catalog');
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({ configPath, secrets });
		try {
			const pending = connectClient(endpoint(host), 'credential-a').then(
				() => ({ kind: 'unexpected-success' }),
				(error: unknown) => ({
					kind: 'rejected',
					message: error instanceof Error ? error.message : String(error),
					code: typeof error === 'object' && error !== null && 'code' in error ? error.code : null,
				}),
			);
			await held.entered;
			if (host.http === undefined) throw new Error('Missing HTTP listener');
			const rotated = {
				...config.auth,
				credentials: config.auth.credentials.map((credential) => ({
					...credential,
					credentialVersion: 2,
					bearerToken: `${credential.bearerToken}-rotated`,
				})),
			};
			const rotation = host.http.activateCredentialSet(rotated);
			held.release();
			expect(await pending).toMatchObject({
				kind: 'rejected',
				code: 401,
			});
			await rotation;
			const fresh = await connectClient(endpoint(host), 'credential-a-rotated');
			try {
				expect((await fresh.client.listTools()).tools.map((tool) => tool.name)).toEqual([
					'alpha__ask__645775a667',
					'alpha__fail__f7bc995a6f',
					'alpha__read__151160dc30',
				]);
			} finally {
				await fresh.client.close();
			}
			expect(alpha.effects).toEqual([]);
		} finally {
			held.release();
			await host.retire();
			await alpha.close();
			await beta.close();
		}
	});
	it('surfaces duplicate full catalog refusal at HTTP ingress and retains S3a-R3 per-tool helper state in compact describe', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		alpha.duplicateDiscovery();
		const config = fixtureConfig(directory, [alpha.url, beta.url], 'catalog');
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({ configPath, secrets });
		try {
			await expect(connectClient(endpoint(host), 'credential-a')).rejects.toMatchObject({
				code: 503,
			});
			expect(alpha.effects).toEqual([]);
		} finally {
			await host.retire();
			await alpha.close();
			await beta.close();
		}
		const partialDirectory = await fixtureDirectory();
		const healthy = await startControlledProvider('alpha');
		const unavailable = await startControlledProvider('beta');
		const partial = fixtureConfig(partialDirectory, [healthy.url, unavailable.url]);
		const own = partial.profiles['profile-a'];
		const foreign = partial.profiles['profile-b'];
		if (own === undefined || foreign === undefined) throw new Error('Missing fixture profiles');
		const partialConfig = nodeHostConfigSchema.parse({
			...partial,
			profiles: {
				...partial.profiles,
				'profile-a': {
					...own,
					profile: {
						...own.profile,
						namespaces: { ...own.profile.namespaces, ...foreign.profile.namespaces },
					},
				},
			},
		});
		await unavailable.close();
		const partialPath = await writeFixtureConfig(partialConfig, partialDirectory);
		const partialHost = await startNodeHost({ configPath: partialPath, secrets });
		const a = await connectClient(endpoint(partialHost), 'credential-a');
		try {
			const described = await a.client.callTool({
				name: 'mcp_portal_describe',
				arguments: {
					requests: [
						{
							id: 'helper',
							tools: [{ namespace: 'alpha', toolName: 'read' }],
							includeTypescriptHelper: true,
						},
						{ id: 'plain', tools: [{ namespace: 'alpha', toolName: 'read' }] },
					],
				},
			});
			expect(decodedResult(described)).toMatchObject({
				ok: true,
				errors: [],
				results: {
					helper: {
						ok: true,
						output: {
							tools: [
								{
									namespace: 'alpha',
									toolName: 'read',
									typescriptHelperUnavailable: {
										kind: 'catalog_preparation_refused',
										refusals: [{ kind: 'upstream_discovery_failed', namespace: 'beta' }],
									},
								},
							],
						},
					},
					plain: { ok: true, output: { tools: [{ namespace: 'alpha', toolName: 'read' }] } },
				},
			});
			expect(successfulOutput(described, 'plain')).not.toHaveProperty(
				'tools.0.typescriptHelperUnavailable',
			);
			expect(healthy.effects).toEqual([]);
		} finally {
			await a.client.close();
			await partialHost.retire();
			await healthy.close();
		}
	});
});
