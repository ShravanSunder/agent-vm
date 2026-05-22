import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import { runMigrateImagesCommand } from './migrate-commands.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

async function createTestDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-migrate-images-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

describe('runMigrateImagesCommand', () => {
	it('rewrites Dockerfile image profiles to managed bases and creates overlays', async () => {
		const targetDirectory = await createTestDirectory();
		const configPath = path.join(targetDirectory, 'config', 'system.jsonc');
		await mkdir(path.dirname(configPath), { recursive: true });
		await mkdir(path.join(targetDirectory, 'vm-images', 'gateways', 'openclaw'), {
			recursive: true,
		});
		await mkdir(path.join(targetDirectory, 'vm-images', 'tool-vms', 'default'), {
			recursive: true,
		});
		await writeFile(
			configPath,
			JSON.stringify({
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: '../vm-images/gateways/openclaw/build-config.jsonc',
							dockerfile: '../vm-images/gateways/openclaw/Dockerfile',
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
							dockerfile: '../vm-images/tool-vms/default/Dockerfile',
						},
					},
				},
			}),
			'utf8',
		);

		const result = await runMigrateImagesCommand({ systemConfigPath: configPath });

		const migratedConfig = await loadJsonConfigFile(configPath);
		expect(result.migratedProfiles).toEqual(['gateway/openclaw', 'toolVm/default']);
		expect(migratedConfig).toMatchObject({
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: '../vm-images/gateways/openclaw/build-config.jsonc',
						source: {
							kind: 'managedBase',
							base: 'openclaw-gateway',
							overlay: '../vm-images/gateways/openclaw/overlay.jsonc',
						},
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
						source: {
							kind: 'managedBase',
							base: 'tool-vm',
							overlay: '../vm-images/tool-vms/default/overlay.jsonc',
						},
					},
				},
			},
		});
		expect(JSON.stringify(migratedConfig)).not.toContain('dockerfile');
		await expect(
			readFile(
				path.join(targetDirectory, 'vm-images', 'gateways', 'openclaw', 'overlay.jsonc'),
				'utf8',
			),
		).resolves.toContain('"schemaVersion": 1');
		await expect(
			readFile(
				path.join(targetDirectory, 'vm-images', 'tool-vms', 'default', 'overlay.jsonc'),
				'utf8',
			),
		).resolves.toContain('"schemaVersion": 1');
	});

	it('preserves authored JSONC comments while rewriting image profiles', async () => {
		const targetDirectory = await createTestDirectory();
		const configPath = path.join(targetDirectory, 'config', 'system.jsonc');
		await mkdir(path.dirname(configPath), { recursive: true });
		await mkdir(path.join(targetDirectory, 'vm-images', 'gateways', 'openclaw'), {
			recursive: true,
		});
		await writeFile(
			configPath,
			[
				'{',
				'  // deployment-owned comment',
				'  "imageProfiles": {',
				'    "gateways": {',
				'      "openclaw": {',
				'        "type": "openclaw",',
				'        // keep this near the gateway image',
				'        "buildConfig": "../vm-images/gateways/openclaw/build-config.jsonc",',
				'        "dockerfile": "../vm-images/gateways/openclaw/Dockerfile"',
				'      }',
				'    },',
				'    "toolVms": {}',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await runMigrateImagesCommand({ systemConfigPath: configPath });

		const migratedConfigText = await readFile(configPath, 'utf8');
		const migratedConfig = await loadJsonConfigFile(configPath);
		expect(result.migratedProfiles).toEqual(['gateway/openclaw']);
		expect(migratedConfigText).toContain('// deployment-owned comment');
		expect(migratedConfigText).toContain('// keep this near the gateway image');
		expect(migratedConfigText).not.toContain('"dockerfile"');
		expect(migratedConfig).toMatchObject({
			imageProfiles: {
				gateways: {
					openclaw: {
						source: {
							kind: 'managedBase',
							base: 'openclaw-gateway',
							overlay: '../vm-images/gateways/openclaw/overlay.jsonc',
						},
					},
				},
			},
		});
	});
});
