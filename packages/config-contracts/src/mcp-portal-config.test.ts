import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	loadMcpPortalConfig,
	openClawMcpPortalPluginConfigSchema,
	resolveMcpPortalProfile,
} from './mcp-portal-config.js';

async function writeConfigFile(text: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-portal-config-'));
	const configPath = join(directory, 'mcp-portal.config.jsonc');
	await writeFile(configPath, text, 'utf8');
	return configPath;
}

describe('loadMcpPortalConfig', () => {
	it('loads optional proxy auth settings, agents, and profile assignments', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"externalAuth": {
				"masterKey": { "source": "environment", "name": "MCP_PORTAL_MASTER_KEY" }
			},
			"mcpProxy": {
					"server": {
						"host": "127.0.0.1",
						"port": 18791
					},
				"auth": {
					"headerName": "authorization"
				}
			},
			"agents": {
				"shravan": { "profile": "builder" }
			},
			"profiles": {
				"default": {
					"enabledNamespaces": []
				},
				"builder": {
					"extends": "default",
					"enabledNamespaces": ["linear"],
					"enabledToolsByNamespace": { "linear": ["create_issue"] },
					"logging": { "enabled": true }
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'builder');
		expect(config.externalAuth?.masterKey).toEqual({
			name: 'MCP_PORTAL_MASTER_KEY',
			source: 'environment',
		});
		expect(config.mcpProxy?.server.port).toBe(18791);
		expect(config.mcpProxy?.auth.headerName).toBe('authorization');
		expect(config.agents.shravan?.profile).toBe('builder');
		expect(profile).toMatchObject({
			enabledNamespaces: ['linear'],
			enabledToolsByNamespace: { linear: ['create_issue'] },
			hiddenToolsByNamespace: {},
			logging: { enabled: true },
			promptContext: { enabled: true, maxNamespaces: 12 },
		});
	});

	it('rejects legacy shared-header portal server config', async () => {
		const configPath = await writeConfigFile(`{
				"schemaVersion": 1,
				"server": {
					"host": "127.0.0.1",
					"port": 18790,
					"accessHeader": {
						"name": "x-agent-vm-mcp-portal-secret",
						"secret": { "source": "environment", "name": "MCP_PORTAL_SERVER_SECRET" }
					}
				},
				"agents": { "shravan": { "profile": "default" } },
				"profiles": { "default": { "enabledNamespaces": [] } }
			}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/server/u);
	});

	it('rejects external proxy hosts outside loopback', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"externalAuth": {
				"masterKey": { "source": "environment", "name": "MCP_PORTAL_MASTER_KEY" }
			},
			"mcpProxy": {
				"server": { "host": "0.0.0.0", "port": 18791 },
				"auth": { "headerName": "authorization" }
			},
			"agents": { "shravan": { "profile": "default" } },
			"profiles": { "default": { "enabledNamespaces": [] } }
		}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/loopback/u);
	});

	it('rejects unknown inherited profiles', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "shravan": { "profile": "builder" } },
			"profiles": {
				"builder": { "extends": "missing", "enabledNamespaces": [] }
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		expect(() => resolveMcpPortalProfile(config, 'builder')).toThrow(
			/unknown MCP profile 'missing'/u,
		);
	});

	it('detects profile inheritance cycles', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": {},
			"profiles": {
				"a": { "extends": "b" },
				"b": { "extends": "a" }
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		expect(() => resolveMcpPortalProfile(config, 'a')).toThrow(/MCP profile inheritance cycle/u);
	});
});

describe('openClawMcpPortalPluginConfigSchema', () => {
	it('rejects legacy subprocess binPath plugin config', () => {
		expect(() =>
			openClawMcpPortalPluginConfigSchema.parse({
				binPath: '/custom/bin/stale-portal-binary',
				configDir: '/home/openclaw/.openclaw/config',
			}),
		).toThrow(/binPath/u);
	});
});
