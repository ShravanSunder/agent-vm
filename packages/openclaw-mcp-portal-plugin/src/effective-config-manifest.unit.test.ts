import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveEffectiveConfigPaths } from './effective-config-manifest.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createTemporaryConfigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'agent-vm-effective-config-manifest-'));
	createdDirectories.push(dir);
	return dir;
}

describe('resolveEffectiveConfigPaths', () => {
	it('falls back to conventional config file names when no manifest exists', async () => {
		const configDir = await createTemporaryConfigDir();

		await expect(resolveEffectiveConfigPaths(configDir)).resolves.toEqual({
			mcpConfigPath: join(configDir, 'mcp.config.jsonc'),
			portalConfigPath: join(configDir, 'mcp-portal.config.jsonc'),
		});
	});

	it('resolves managed effective config files through the manifest pointer', async () => {
		const configDir = await createTemporaryConfigDir();
		await writeFile(
			join(configDir, 'mcp-portal-effective-manifest.json'),
			JSON.stringify({
				mcpConfigFile: 'mcp.config.generation-1.jsonc',
				portalConfigFile: 'mcp-portal.config.generation-1.jsonc',
				schemaVersion: 1,
			}),
			'utf8',
		);

		await expect(resolveEffectiveConfigPaths(configDir)).resolves.toEqual({
			mcpConfigPath: join(configDir, 'mcp.config.generation-1.jsonc'),
			portalConfigPath: join(configDir, 'mcp-portal.config.generation-1.jsonc'),
		});
	});

	it('rejects manifest file names that escape the config directory', async () => {
		const configDir = await createTemporaryConfigDir();
		await writeFile(
			join(configDir, 'mcp-portal-effective-manifest.json'),
			JSON.stringify({
				mcpConfigFile: '../mcp.config.jsonc',
				portalConfigFile: 'mcp-portal.config.generation-1.jsonc',
				schemaVersion: 1,
			}),
			'utf8',
		);

		await expect(resolveEffectiveConfigPaths(configDir)).rejects.toThrow(/safe mcpConfigFile/u);
	});
});
