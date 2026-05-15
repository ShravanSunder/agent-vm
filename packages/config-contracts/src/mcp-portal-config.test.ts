import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMcpPortalConfig, resolveMcpPortalProfile } from './mcp-portal-config.js';

async function writeConfigFile(text: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-portal-config-'));
	const configPath = join(directory, 'mcp-portal.config.jsonc');
	await writeFile(configPath, text, 'utf8');
	return configPath;
}

describe('loadMcpPortalConfig', () => {
	it('loads server settings, agents, and profile assignments', async () => {
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
		expect(config.server.port).toBe(18790);
		expect(config.agents.shravan?.profile).toBe('builder');
		expect(profile).toMatchObject({
			enabledNamespaces: ['linear'],
			enabledToolsByNamespace: { linear: ['create_issue'] },
			hiddenToolsByNamespace: {},
			logging: { enabled: true },
			promptContext: { enabled: true, maxNamespaces: 12 },
		});
	});

	it('rejects unknown inherited profiles', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"server": {
				"accessHeader": {
					"name": "x-agent-vm-mcp-portal-secret",
					"secret": { "source": "environment", "name": "MCP_PORTAL_SERVER_SECRET" }
				}
			},
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
			"server": {
				"accessHeader": {
					"name": "x-agent-vm-mcp-portal-secret",
					"secret": { "source": "environment", "name": "MCP_PORTAL_SERVER_SECRET" }
				}
			},
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
