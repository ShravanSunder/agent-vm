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

	it('loads provider secret formats for bearer and prefix rendering', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"linear": {
					"kind": "mcp",
					"namespace": "linear",
					"transport": {
						"kind": "streamable-http",
						"url": "https://mcp.linear.test/mcp",
						"headers": {
							"authorization": {
								"source": "environment",
								"name": "LINEAR_MCP_TOKEN",
								"format": { "kind": "bearer" }
							},
							"x-vendor-token": {
								"source": "1password",
								"ref": "op://agent-vm/vendor/credential",
								"format": { "kind": "prefix", "prefix": "Token" }
							}
						}
					}
				}
			}
		}`);

		const config = await loadMcpConfig(configPath);

		expect(mcpConfigToResolvedProviders(config)).toEqual([
			{
				headers: {
					authorization: {
						format: { kind: 'bearer' },
						name: 'LINEAR_MCP_TOKEN',
						source: 'environment',
					},
					'x-vendor-token': {
						format: { kind: 'prefix', prefix: 'Token' },
						ref: 'op://agent-vm/vendor/credential',
						source: '1password',
					},
				},
				namespace: 'linear',
				transport: 'streamable-http',
				url: 'https://mcp.linear.test/mcp',
			},
		]);
	});

	it('rejects unsafe provider secret prefixes', async () => {
		await Promise.all(
			['', ' ', 'Token ', 'Token\nValue'].map(async (prefix) => {
				const configPath = await writeConfigFile(`{
					"schemaVersion": 1,
					"providers": {
						"linear": {
							"kind": "mcp",
							"namespace": "linear",
							"transport": {
								"kind": "streamable-http",
								"url": "https://mcp.linear.test/mcp",
								"headers": {
									"authorization": {
										"source": "environment",
										"name": "LINEAR_MCP_TOKEN",
										"format": { "kind": "prefix", "prefix": ${JSON.stringify(prefix)} }
									}
								}
							}
						}
					}
				}`);

				await expect(loadMcpConfig(configPath)).rejects.toThrow(/prefix/u);
			}),
		);
	});

	it('resolves stdio MCP providers with command, args, cwd, and env', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"localSearch": {
					"kind": "mcp",
					"namespace": "local-search",
					"transport": {
						"kind": "stdio",
						"command": "node",
						"args": ["dist/server.js", "--stdio"],
						"cwd": "/work/mcp/local-search",
						"env": {
							"LOCAL_SEARCH_TOKEN": {
								"source": "environment",
								"name": "LOCAL_SEARCH_TOKEN"
							}
						}
					}
				}
			}
		}`);

		const config = await loadMcpConfig(configPath);

		expect(mcpConfigToResolvedProviders(config)).toEqual([
			{
				args: ['dist/server.js', '--stdio'],
				command: 'node',
				cwd: '/work/mcp/local-search',
				env: {
					LOCAL_SEARCH_TOKEN: {
						name: 'LOCAL_SEARCH_TOKEN',
						source: 'environment',
					},
				},
				namespace: 'local-search',
				transport: 'stdio',
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

	it('rejects non-http remote MCP transport URLs', async () => {
		const fileUrlConfig = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"localFile": {
					"kind": "mcp",
					"namespace": "local-file",
					"transport": { "kind": "streamable-http", "url": "file:///etc/passwd" }
				}
			}
		}`);
		const ftpUrlConfig = await writeConfigFile(`{
			"schemaVersion": 1,
			"providers": {
				"ftp": {
					"kind": "mcp",
					"namespace": "ftp",
					"transport": { "kind": "sse", "url": "ftp://example.com/mcp" }
				}
			}
		}`);

		await expect(loadMcpConfig(fileUrlConfig)).rejects.toThrow(/http.*https/u);
		await expect(loadMcpConfig(ftpUrlConfig)).rejects.toThrow(/http.*https/u);
	});
});
