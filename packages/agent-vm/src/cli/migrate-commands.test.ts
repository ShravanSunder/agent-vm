import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import { runMigrateImagesCommand, runMigrateMcpPortalConfigCommand } from './migrate-commands.js';

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

describe('runMigrateMcpPortalConfigCommand', () => {
	async function writeOpenClawMigrationFixture(targetDirectory: string): Promise<{
		readonly openClawConfigPath: string;
		readonly systemConfigPath: string;
	}> {
		const systemConfigPath = path.join(targetDirectory, 'config', 'system.jsonc');
		const openClawConfigPath = path.join(
			targetDirectory,
			'config',
			'gateways',
			'shravan',
			'openclaw.json',
		);
		await mkdir(path.dirname(openClawConfigPath), { recursive: true });
		await writeFile(
			systemConfigPath,
			[
				'{',
				'\t// deployment-owned comment',
				'\t"host": { "controllerPort": 18800, "projectNamespace": "agent-vm" },',
				'\t"cacheDir": "../cache",',
				'\t"imageProfiles": {',
				'\t\t"gateways": {',
				'\t\t\t"openclaw": {',
				'\t\t\t\t"type": "openclaw",',
				'\t\t\t\t"buildConfig": "../vm-images/gateways/openclaw/build-config.jsonc"',
				'\t\t\t}',
				'\t\t},',
				'\t\t"toolVms": {',
				'\t\t\t"default": {',
				'\t\t\t\t"type": "toolVm",',
				'\t\t\t\t"buildConfig": "../vm-images/tool-vms/default/build-config.jsonc"',
				'\t\t\t}',
				'\t\t}',
				'\t},',
				'\t"zones": [',
				'\t\t{',
				'\t\t\t"id": "shravan",',
				'\t\t\t"gateway": {',
				'\t\t\t\t"type": "openclaw",',
				'\t\t\t\t"memory": "2G",',
				'\t\t\t\t"cpus": 2,',
				'\t\t\t\t"port": 18791,',
				'\t\t\t\t"config": "./gateways/shravan/openclaw.json",',
				'\t\t\t\t"imageProfile": "openclaw",',
				'\t\t\t\t"stateDir": "../state/shravan",',
				'\t\t\t\t"zoneFilesDir": "../zone-files/shravan"',
				'\t\t\t},',
				'\t\t\t"secrets": {},',
				'\t\t\t"allowedHosts": ["api.openai.com"],',
				'\t\t\t"defaultToolVmProfile": "standard",',
				'\t\t\t"agentToolVmProfiles": {}',
				'\t\t}',
				'\t],',
				'\t"toolVmProfiles": {',
				'\t\t"standard": { "memory": "1G", "cpus": 1, "imageProfile": "default" }',
				'\t},',
				'\t"tcpPool": { "basePort": 19000, "size": 12 }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
		await writeFile(
			openClawConfigPath,
			`${JSON.stringify(
				{
					agents: {
						list: [
							{ id: 'sun', workspace: '/zone/agents/sun' },
							{ id: 'shravan', workspace: '/zone/agents/shravan' },
						],
					},
					mcp: {
						servers: {
							existing: {
								transport: 'streamable-http',
								url: 'https://example.com/mcp',
							},
							mcp_portal_old: {
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18789/mcp-portal/bindings/old/mcp',
							},
						},
					},
					plugins: {
						entries: {
							'mcp-portal': {
								enabled: true,
								hooks: { allowPromptInjection: true },
								config: {
									binPath: '/custom/bin/stale-portal-binary',
									promptContext: { enabled: true },
								},
							},
						},
					},
				},
				null,
				'\t',
			)}\n`,
			'utf8',
		);
		return { openClawConfigPath, systemConfigPath };
	}

	it('creates MCP config files and system zone references from existing OpenClaw agents', async () => {
		const targetDirectory = await createTestDirectory();
		const { openClawConfigPath, systemConfigPath } =
			await writeOpenClawMigrationFixture(targetDirectory);

		const result = await runMigrateMcpPortalConfigCommand({ systemConfigPath });

		const systemConfig = await loadJsonConfigFile(systemConfigPath);
		const mcpConfig = await loadJsonConfigFile(
			path.join(targetDirectory, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'),
		);
		const portalConfig = await loadJsonConfigFile(
			path.join(targetDirectory, 'config', 'gateways', 'shravan', 'mcp-portal.config.jsonc'),
		);
		const openClawConfig = await loadJsonConfigFile(openClawConfigPath);
		expect(result).toEqual({
			createdFiles: [
				'config/schemas/system.schema.json',
				'config/schemas/mcp.schema.json',
				'config/schemas/mcp-portal.schema.json',
				'config/gateways/shravan/mcp.config.jsonc',
				'config/gateways/shravan/mcp-portal.config.jsonc',
			],
			migratedZones: ['shravan'],
			skippedZones: [],
		});
		expect(systemConfig).toMatchObject({
			$schema: './schemas/system.schema.json',
			schemaVersion: 1,
			zones: [
				{
					agents: [{ id: 'sun' }, { id: 'shravan' }],
					mcpPortal: { configDir: './gateways/shravan' },
				},
			],
		});
		expect(mcpConfig).toMatchObject({
			$schema: '../../schemas/mcp.schema.json',
			schemaVersion: 1,
			providers: {},
		});
		expect(portalConfig).toMatchObject({
			$schema: '../../schemas/mcp-portal.schema.json',
			schemaVersion: 1,
			agents: {
				sun: { profile: 'default' },
				shravan: { profile: 'default' },
			},
			profiles: { default: { enabledNamespaces: [] } },
		});
		expect(openClawConfig).toMatchObject({
			mcp: {
				servers: {
					existing: {
						transport: 'streamable-http',
						url: 'https://example.com/mcp',
					},
				},
			},
			plugins: {
				entries: {
					'mcp-portal': {
						config: {
							configDir: '/home/openclaw/.openclaw/config',
						},
					},
				},
			},
		});
		await expect(
			loadJsonConfigFile(path.join(targetDirectory, 'config', 'schemas', 'system.schema.json')),
		).resolves.toMatchObject({ $id: 'agent-vm:system:1' });
		await expect(
			loadJsonConfigFile(path.join(targetDirectory, 'config', 'schemas', 'mcp.schema.json')),
		).resolves.toMatchObject({ $id: 'agent-vm:mcp:1' });
		await expect(
			loadJsonConfigFile(path.join(targetDirectory, 'config', 'schemas', 'mcp-portal.schema.json')),
		).resolves.toMatchObject({ $id: 'agent-vm:mcp-portal:1' });
		expect(JSON.stringify(openClawConfig)).not.toContain('promptContext');
		expect(JSON.stringify(openClawConfig)).not.toContain('mcp_portal_old');
	});

	it('keeps absolute OpenClaw gateway config directories absolute during MCP migration', async () => {
		const targetDirectory = await createTestDirectory();
		const { openClawConfigPath, systemConfigPath } =
			await writeOpenClawMigrationFixture(targetDirectory);
		const originalSystemConfigText = await readFile(systemConfigPath, 'utf8');
		await writeFile(
			systemConfigPath,
			originalSystemConfigText.replace(
				'"config": "./gateways/shravan/openclaw.json"',
				`"config": ${JSON.stringify(openClawConfigPath)}`,
			),
			'utf8',
		);

		await runMigrateMcpPortalConfigCommand({ systemConfigPath });

		const systemConfig = await loadJsonConfigFile(systemConfigPath);
		const expectedConfigDir = path.dirname(openClawConfigPath).replaceAll(path.sep, path.posix.sep);
		expect(systemConfig).toMatchObject({
			zones: [
				{
					mcpPortal: { configDir: expectedConfigDir },
				},
			],
		});
		await expect(
			readFile(path.join(expectedConfigDir, 'mcp.config.jsonc'), 'utf8'),
		).resolves.toContain('"schemaVersion": 1');
		await expect(
			readFile(path.join(expectedConfigDir, 'mcp-portal.config.jsonc'), 'utf8'),
		).resolves.toContain('"schemaVersion": 1');
	});

	it('preserves JSONC comments in system config while adding MCP references', async () => {
		const targetDirectory = await createTestDirectory();
		const { systemConfigPath } = await writeOpenClawMigrationFixture(targetDirectory);

		await runMigrateMcpPortalConfigCommand({ systemConfigPath });

		const migratedText = await readFile(systemConfigPath, 'utf8');
		expect(migratedText).toContain('// deployment-owned comment');
		expect(migratedText).toContain('"mcpPortal"');
		expect(migratedText).toContain('"schemaVersion": 1');
	});
});
