import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { type NodeHostConfig, loadNodeHostConfig } from '#node-host/configuration/node-host-config';
import { startNodeHost } from '#node-host/node-host-startup';
import {
	fixtureConfig,
	fixtureDirectory,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

const unusedUrls = ['https://one.example/mcp', 'https://two.example/mcp'] as const;
const resolver = { resolve: async (): Promise<string> => 'fixture-only-secret' };
const invalidConfigurations: readonly {
	readonly name: string;
	readonly change: (config: NodeHostConfig) => unknown;
}[] = [
	{
		name: 'missing operation bounds',
		change: (config) => ({ ...config, operationStoreBounds: undefined }),
	},
	...([0, -1, 1.5] as const).map((value) => ({
		name: `invalid operation count ${value}`,
		change: (config: NodeHostConfig): unknown => ({
			...config,
			operationStoreBounds: { ...config.operationStoreBounds, maximumOperations: value },
		}),
	})),
	...([0, -1, 1.5, 4 * 1024 * 1024] as const).map((value) => ({
		name: `invalid or too-small record bound ${value}`,
		change: (config: NodeHostConfig): unknown => ({
			...config,
			operationStoreBounds: { ...config.operationStoreBounds, maximumRecordBytes: value },
		}),
	})),
	{
		name: 'missing operation count',
		change: (config) => ({
			...config,
			operationStoreBounds: { maximumRecordBytes: config.operationStoreBounds.maximumRecordBytes },
		}),
	},
	{
		name: 'missing record byte bound',
		change: (config) => ({ ...config, operationStoreBounds: { maximumOperations: 2 } }),
	},
	{ name: 'missing authentication', change: (config) => ({ ...config, auth: undefined }) },
	{
		name: 'missing operation store',
		change: (config) => ({ ...config, storeDirectory: undefined }),
	},
	{ name: 'missing assignments', change: (config) => ({ ...config, profiles: {} }) },
	{
		name: 'incomplete profile',
		change: (config) => ({
			...config,
			profiles: {
				'profile-a': {
					revision: config.revision,
					profile: {
						profileId: 'profile-a',
						namespaces: { alpha: { backendKind: 'mcp_provider' } },
					},
				},
			},
		}),
	},
	{
		name: 'unsupported binding',
		change: (config) => ({
			...config,
			mcp: {
				schemaVersion: 1,
				providers: { alpha: { kind: 'mcp', namespace: 'alpha', transport: { kind: 'unknown' } } },
			},
		}),
	},
	{
		name: 'wrong configured audience',
		change: (config) => ({ ...config, auth: { ...config.auth, audience: 'another-service:mcp' } }),
	},
	{
		name: 'plaintext remote binding',
		change: (config) => ({ ...config, listener: { ...config.listener, hostname: '0.0.0.0' } }),
	},
	{
		name: 'unsupported workspace binding',
		change: (config) => ({ ...config, workspaceLayer: 'configured' }),
	},
];

describe('real Node host loader and startup boundary', () => {
	it.each(invalidConfigurations)('refuses $name before serving', async ({ change }) => {
		const directory = await fixtureDirectory();
		const config = fixtureConfig(directory, unusedUrls);
		const configPath = path.join(directory, 'invalid.jsonc');
		await writeFile(configPath, JSON.stringify(change(config)));
		await expect(startNodeHost({ configPath, secrets: resolver })).rejects.toThrow();
	});
	it('loads JSONC, resolves the explicit store relative to its config, preserves copied provider defaults, and rejects malformed JSONC', async () => {
		const directory = await fixtureDirectory();
		const config = fixtureConfig(directory, unusedUrls);
		const configPath = await writeFixtureConfig(
			{ ...config, storeDirectory: 'relative-store' },
			directory,
		);
		expect((await loadNodeHostConfig(configPath)).storeDirectory).toBe(
			path.join(directory, 'relative-store'),
		);
		expect((await loadNodeHostConfig(configPath)).mcp.providers.alpha?.discovery).toEqual({});
		await writeFile(configPath, '{ malformed }');
		await expect(loadNodeHostConfig(configPath)).rejects.toThrow(/Invalid JSONC/u);
	});
	it('rolls back the writer fence when a required injected secret cannot resolve', async () => {
		const directory = await fixtureDirectory();
		const configPath = await writeFixtureConfig(fixtureConfig(directory, unusedUrls), directory);
		await expect(
			startNodeHost({
				configPath,
				secrets: {
					resolve: async () => {
						throw new Error('unavailable test resolver');
					},
				},
			}),
		).rejects.toThrow();
		const recovered = await startNodeHost({ configPath, secrets: resolver });
		expect(recovered.http?.endpoint.protocol).toBe('http:');
		await recovered.retire();
	});
	it('rolls back after listener startup fails, so the same store can start after the port conflict is removed', async () => {
		const occupied = createServer();
		occupied.listen(0, '127.0.0.1');
		await once(occupied, 'listening');
		const address = occupied.address();
		if (address === null || typeof address === 'string')
			throw new Error('Missing listener address');
		const directory = await fixtureDirectory();
		const config = fixtureConfig(directory, unusedUrls);
		if (config.listener.kind !== 'http') throw new Error('Expected HTTP listener');
		const configPath = await writeFixtureConfig(
			{ ...config, listener: { ...config.listener, port: address.port } },
			directory,
		);
		try {
			await expect(startNodeHost({ configPath, secrets: resolver })).rejects.toThrow(/EADDRINUSE/u);
		} finally {
			await new Promise<void>((resolve, reject) =>
				occupied.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		}
		const recovered = await startNodeHost({ configPath, secrets: resolver });
		await recovered.retire();
	});
});
