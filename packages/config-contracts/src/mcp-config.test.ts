import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMcpConfig, mcpConfigToResolvedProviders } from './mcp-config.js';

async function writeConfigFile(text: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-config-'));
	const configPath = join(directory, 'mcp.config.jsonc');
	await writeFile(configPath, text, 'utf8');
	return configPath;
}

describe('loadMcpConfig', () => {
	it('loads strict upstream MCP provider config from JSONC', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"linear": {
					"kind": "mcp",
					"namespace": "linear",
					"discovery": { "summary": "Linear work tracking" },
					"transport": {
						"kind": "streamable-http",
						"url": "https://mcp.linear.test/mcp",
						"headers": {
							"authorization": { "source": "environment", "name": "LINEAR_MCP_TOKEN" }
						}
					}
				}
			}
		}`);

		const config = await loadMcpConfig(configPath);
		expect(config.providers.linear?.transport.kind).toBe('streamable-http');
		expect(mcpConfigToResolvedProviders(config)).toEqual([
			{
				headers: {
					authorization: { source: 'environment', name: 'LINEAR_MCP_TOKEN' },
				},
				namespace: 'linear',
				transport: 'streamable-http',
				url: 'https://mcp.linear.test/mcp',
			},
		]);
	});

	it('rejects unknown provider fields', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"linear": {
					"kind": "mcp",
					"namespace": "linear",
					"transport": { "kind": "streamable-http", "url": "https://mcp.linear.test/mcp" },
					"extra": true
				}
			}
		}`);

		await expect(loadMcpConfig(configPath)).rejects.toThrow(/Unrecognized key/u);
	});

	it('rejects 1Password secrets that are not op refs', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"linear": {
					"kind": "mcp",
					"namespace": "linear",
					"secretPolicies": {
						"authorization": { "injection": "http-mediation", "hosts": ["api.linear.app"] }
					},
					"transport": {
						"kind": "streamable-http",
						"url": "https://mcp.linear.test/mcp",
						"headers": {
							"authorization": { "source": "1password", "ref": "not-an-op-ref" }
						}
					}
				}
			}
		}`);

		await expect(loadMcpConfig(configPath)).rejects.toThrow(/op:\/\//u);
	});

	it('validates secret policy hosts against injection mode', async () => {
		const mediatedWithoutHosts = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"linear": {
					"kind": "mcp",
					"namespace": "linear",
					"secretPolicies": {
						"authorization": { "injection": "http-mediation", "hosts": [] }
					},
					"transport": { "kind": "streamable-http", "url": "https://mcp.linear.test/mcp" }
				}
			}
		}`);
		const envWithHosts = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"linear": {
					"kind": "mcp",
					"namespace": "linear",
					"secretPolicies": {
						"authorization": { "injection": "env", "hosts": ["api.linear.app"] }
					},
					"transport": { "kind": "streamable-http", "url": "https://mcp.linear.test/mcp" }
				}
			}
		}`);

		await expect(loadMcpConfig(mediatedWithoutHosts)).rejects.toThrow(/http-mediation/u);
		await expect(loadMcpConfig(envWithHosts)).rejects.toThrow(/env.*hosts/u);
	});
});
