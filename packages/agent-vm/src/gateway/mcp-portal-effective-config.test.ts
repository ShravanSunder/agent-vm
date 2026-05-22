import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SecretResolver } from '@agent-vm/secrets';
import type { SecretRef } from '@agent-vm/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	planMcpPortalEffectiveConfig,
	writeMcpPortalEffectiveConfig,
} from './mcp-portal-effective-config.js';

const createdDirectories: string[] = [];
type TestSecretResolver = SecretResolver & { readonly resolveAllMock: ReturnType<typeof vi.fn> };

const effectiveConfigManifestFileName = 'mcp-portal-effective-manifest.json';

interface TestEffectiveConfigManifest {
	readonly mcpConfigFile: string;
	readonly portalConfigFile: string;
	readonly schemaVersion: 1;
}

afterEach(async () => {
	await Promise.all(
		createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createAuthoredDir(props: {
	readonly mcpConfig: unknown;
	readonly portalConfig?: unknown;
}): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'agent-vm-mcp-portal-authored-'));
	createdDirectories.push(dir);
	await writeFile(path.join(dir, 'mcp.config.jsonc'), JSON.stringify(props.mcpConfig), 'utf8');
	await writeFile(
		path.join(dir, 'mcp-portal.config.jsonc'),
		JSON.stringify(
			props.portalConfig ?? {
				agents: { shravan: { profile: 'default' } },
				profiles: { default: { enabledNamespaces: ['deepwiki'] } },
				schemaVersion: 1,
			},
		),
		'utf8',
	);
	return dir;
}

function createSecretResolver(values: Readonly<Record<string, string>>): TestSecretResolver {
	const resolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
		Object.fromEntries(
			Object.entries(refs).map(([name, ref]) => {
				if (ref.source === 'config') {
					return [name, ref.value];
				}
				const value = values[ref.ref];
				if (value === undefined) {
					throw new Error(`missing secret ${ref.ref}`);
				}
				return [name, value];
			}),
		),
	);
	return {
		resolve: async (secretRef) => {
			if (secretRef.source === 'config') {
				return secretRef.value;
			}
			const value = values[secretRef.ref];
			if (value === undefined) {
				throw new Error(`missing secret ${secretRef.ref}`);
			}
			return value;
		},
		resolveAll,
		resolveAllMock: resolveAll,
	} satisfies SecretResolver & { readonly resolveAllMock: typeof resolveAll };
}

async function readEffectiveConfigManifest(
	effectiveDir: string,
): Promise<TestEffectiveConfigManifest> {
	const manifest: unknown = JSON.parse(
		await readFile(path.join(effectiveDir, effectiveConfigManifestFileName), 'utf8'),
	);
	if (
		typeof manifest !== 'object' ||
		manifest === null ||
		!('schemaVersion' in manifest) ||
		!('mcpConfigFile' in manifest) ||
		!('portalConfigFile' in manifest)
	) {
		throw new Error('test effective config manifest has unexpected shape');
	}
	const schemaVersion = manifest.schemaVersion;
	const mcpConfigFile = manifest.mcpConfigFile;
	const portalConfigFile = manifest.portalConfigFile;
	if (
		schemaVersion !== 1 ||
		typeof mcpConfigFile !== 'string' ||
		typeof portalConfigFile !== 'string'
	) {
		throw new Error('test effective config manifest has unexpected shape');
	}
	return { mcpConfigFile, portalConfigFile, schemaVersion };
}

async function readEffectiveMcpConfig<TConfig>(effectiveDir: string): Promise<TConfig> {
	const manifest = await readEffectiveConfigManifest(effectiveDir);
	return JSON.parse(
		await readFile(path.join(effectiveDir, manifest.mcpConfigFile), 'utf8'),
	) as TConfig;
}

async function readEffectivePortalConfig<TConfig>(effectiveDir: string): Promise<TConfig> {
	const manifest = await readEffectiveConfigManifest(effectiveDir);
	return JSON.parse(
		await readFile(path.join(effectiveDir, manifest.portalConfigFile), 'utf8'),
	) as TConfig;
}

describe('MCP Portal effective config materialization', () => {
	it('reports HTTP provider URL hosts as required gateway egress', async () => {
		const mcpConfig = {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		};
		const authoredDir = await createAuthoredDir({
			mcpConfig,
		});
		const zoneEgressHosts = [{ audience: 'gateway', host: 'api.openai.com' }];

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['mcp.deepwiki.com'],
		});
		expect(mcpConfig.providers.deepwiki.transport).toEqual({
			kind: 'streamable-http',
			url: 'https://mcp.deepwiki.com/mcp',
		});
		expect(zoneEgressHosts).toEqual([{ audience: 'gateway', host: 'api.openai.com' }]);
	});

	it('does not report loopback HTTP provider URLs as external gateway egress', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					local_proxy: {
						kind: 'mcp',
						namespace: 'local_proxy',
						transport: { kind: 'streamable-http', url: 'http://127.0.0.1:18791/mcp' },
					},
					localhost_proxy: {
						kind: 'mcp',
						namespace: 'localhost_proxy',
						transport: { kind: 'sse', url: 'http://localhost:18792/sse' },
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: [],
		});
	});

	it('reports SSE provider URL hosts as required gateway egress', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					linear: {
						kind: 'mcp',
						namespace: 'linear',
						transport: { kind: 'sse', url: 'https://events.linear.app/sse' },
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['events.linear.app'],
		});
	});

	it('reports stdio required egress hosts', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					tavily: {
						kind: 'mcp',
						namespace: 'tavily',
						transport: {
							args: ['-y', 'tavily-mcp'],
							command: 'npx',
							kind: 'stdio',
							networkAccess: 'declared',
							requiredEgressHosts: ['api.tavily.com'],
						},
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['api.tavily.com'],
		});
	});

	it('requires stdio network access declarations', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					tavily: {
						kind: 'mcp',
						namespace: 'tavily',
						transport: { args: ['-y', 'tavily-mcp'], command: 'npx', kind: 'stdio' },
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/tavily.*networkAccess/u);
	});

	it('requires stdio egress declarations for network-capable providers', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					tavily: {
						kind: 'mcp',
						namespace: 'tavily',
						transport: {
							args: ['-y', 'tavily-mcp'],
							command: 'npx',
							kind: 'stdio',
							networkAccess: 'declared',
						},
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/tavily.*requiredEgressHosts/u);
	});

	it('allows explicitly local-only stdio providers', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					local_repo: {
						kind: 'mcp',
						namespace: 'local_repo',
						transport: {
							args: ['server'],
							command: 'local-mcp',
							kind: 'stdio',
							networkAccess: 'none',
						},
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: [],
		});
	});

	it('rejects malformed provider and mediated secret hosts', async () => {
		await Promise.all(
			['*.example.com', '', 'https://api.example.com/path'].map(async (host) => {
				const authoredDir = await createAuthoredDir({
					mcpConfig: {
						providers: {
							tavily: {
								kind: 'mcp',
								namespace: 'tavily',
								secretPolicies: {
									TAVILY_API_KEY: { hosts: [host], injection: 'http-mediation' },
								},
								transport: {
									args: ['-y', 'tavily-mcp'],
									command: 'npx',
									env: {
										TAVILY_API_KEY: {
											ref: 'op://agent-vm/tavily/credential',
											source: '1password',
										},
									},
									kind: 'stdio',
									networkAccess: 'declared',
									requiredEgressHosts: ['api.tavily.com'],
								},
							},
						},
						schemaVersion: 1,
					},
				});

				await expect(
					planMcpPortalEffectiveConfig({
						authoredConfigDir: authoredDir,
						effectiveHostConfigDir: path.join(authoredDir, 'effective'),
						effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
						secretResolver: createSecretResolver({}),
						zoneId: 'shravan',
					}),
				).rejects.toThrow(/secret policy TAVILY_API_KEY/u);
			}),
		);
	});

	it('deduplicates required gateway egress hosts', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					linear: {
						kind: 'mcp',
						namespace: 'linear',
						secretPolicies: {
							authorization: { hosts: ['api.linear.app'], injection: 'http-mediation' },
						},
						transport: {
							headers: {
								authorization: {
									ref: 'op://agent-vm/linear/credential',
									source: '1password',
								},
							},
							kind: 'streamable-http',
							url: 'https://api.linear.app/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['api.linear.app'],
		});
	});

	it('strips external proxy auth from managed effective portal config', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {},
				schemaVersion: 1,
			},
			portalConfig: {
				agents: {
					shravan: {
						hmacKey: {
							ref: 'op://agent-vm/shravan-mcp-portal-approval/credential',
							source: '1password',
						},
						profile: 'default',
					},
				},
				externalAuth: {
					masterKey: {
						ref: 'op://agent-vm/sunfam-mcp-portal-external-auth/credential',
						source: '1password',
					},
				},
				mcpProxy: {
					auth: { headerName: 'authorization' },
					server: { host: '127.0.0.1', port: 18791 },
				},
				profiles: { default: { enabledNamespaces: [] } },
				schemaVersion: 1,
			},
		});
		const effectiveDir = path.join(authoredDir, 'effective');

		await writeMcpPortalEffectiveConfig({
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
			secretResolver: createSecretResolver({
				'op://agent-vm/sunfam-mcp-portal-external-auth/credential': 'master-key',
			}),
			zoneId: 'shravan',
		});
		const effectivePortalConfig =
			await readEffectivePortalConfig<Record<string, unknown>>(effectiveDir);

		expect(JSON.stringify(effectivePortalConfig)).not.toContain('source');
		expect(JSON.stringify(effectivePortalConfig)).not.toContain('op://');
		expect(effectivePortalConfig.agents).toEqual({
			shravan: { credentialVersion: 1, profile: 'default' },
		});
		expect(effectivePortalConfig.externalAuth).toBeUndefined();
		expect(effectivePortalConfig.mcpProxy).toBeUndefined();
	});

	it('resolves 1Password provider secrets once and writes environment-only effective configs', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					tavily: {
						kind: 'mcp',
						namespace: 'tavily',
						secretPolicies: {
							TAVILY_API_KEY: { hosts: ['api.tavily.com'], injection: 'http-mediation' },
						},
						transport: {
							args: ['-y', 'tavily-mcp'],
							command: 'npx',
							env: {
								TAVILY_API_KEY: {
									ref: 'op://agent-vm/tavily/credential',
									source: '1password',
								},
							},
							kind: 'stdio',
							networkAccess: 'declared',
							requiredEgressHosts: ['api.tavily.com'],
						},
					},
				},
				schemaVersion: 1,
			},
		});
		const effectiveDir = path.join(authoredDir, 'effective');
		const secretResolver = createSecretResolver({
			'op://agent-vm/tavily/credential': 'resolved-tavily',
		});

		const result = await writeMcpPortalEffectiveConfig({
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
			secretResolver,
			zoneId: 'shravan',
		});
		const effectiveMcpConfig = await readEffectiveMcpConfig<{
			readonly providers: Record<string, { readonly transport: { readonly env: unknown } }>;
		}>(effectiveDir);

		expect(secretResolver.resolveAllMock).toHaveBeenCalledTimes(1);
		expect(effectiveMcpConfig.providers.tavily?.transport.env).toEqual({
			TAVILY_API_KEY: {
				name: 'AGENT_VM_MCP_TAVILY_TAVILY_API_KEY',
				source: 'environment',
			},
		});
		expect(result.runtimeMediatedSecrets).toEqual({
			AGENT_VM_MCP_TAVILY_TAVILY_API_KEY: {
				hosts: ['api.tavily.com'],
				value: 'resolved-tavily',
			},
		});
		expect(result.runtimeEnvironment).toEqual({});
		expect(result.pluginConfig).toEqual({
			configDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
		});
	});

	it('publishes generated effective configs through a single manifest pointer', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					linear: {
						kind: 'mcp',
						namespace: 'linear',
						transport: { kind: 'streamable-http', url: 'https://api.linear.app/mcp' },
					},
				},
				schemaVersion: 1,
			},
		});
		const effectiveDir = path.join(authoredDir, 'effective');

		await writeMcpPortalEffectiveConfig({
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
			secretResolver: createSecretResolver({}),
			zoneId: 'shravan',
		});
		const manifest = await readEffectiveConfigManifest(effectiveDir);

		expect(manifest.mcpConfigFile).toMatch(/^mcp\.config\.[0-9a-f-]+\.jsonc$/u);
		expect(manifest.portalConfigFile).toMatch(/^mcp-portal\.config\.[0-9a-f-]+\.jsonc$/u);
		await expect(
			readFile(path.join(effectiveDir, manifest.mcpConfigFile), 'utf8'),
		).resolves.toContain('linear');
		await expect(
			readFile(path.join(effectiveDir, manifest.portalConfigFile), 'utf8'),
		).resolves.toContain('shravan');
	});

	it('generates provider-scoped secret env names to avoid cross-provider collisions', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					linear: {
						kind: 'mcp',
						namespace: 'linear',
						secretPolicies: {
							authorization: { hosts: ['api.linear.app'], injection: 'http-mediation' },
						},
						transport: {
							headers: {
								authorization: {
									ref: 'op://agent-vm/linear/credential',
									source: '1password',
								},
							},
							kind: 'streamable-http',
							url: 'https://api.linear.app/mcp',
						},
					},
					notion: {
						kind: 'mcp',
						namespace: 'notion',
						secretPolicies: {
							authorization: { hosts: ['api.notion.com'], injection: 'http-mediation' },
						},
						transport: {
							headers: {
								authorization: {
									ref: 'op://agent-vm/notion/credential',
									source: '1password',
								},
							},
							kind: 'streamable-http',
							url: 'https://api.notion.com/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
		});
		const effectiveDir = path.join(authoredDir, 'effective');
		const secretResolver = createSecretResolver({
			'op://agent-vm/linear/credential': 'linear-token',
			'op://agent-vm/notion/credential': 'notion-token',
		});

		const result = await writeMcpPortalEffectiveConfig({
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
			secretResolver,
			zoneId: 'shravan',
		});
		const effectiveMcpConfig = await readEffectiveMcpConfig<{
			readonly providers: Record<string, { readonly transport: { readonly headers: unknown } }>;
		}>(effectiveDir);

		expect(effectiveMcpConfig.providers.linear?.transport.headers).toEqual({
			authorization: { name: 'AGENT_VM_MCP_LINEAR_AUTHORIZATION', source: 'environment' },
		});
		expect(effectiveMcpConfig.providers.notion?.transport.headers).toEqual({
			authorization: { name: 'AGENT_VM_MCP_NOTION_AUTHORIZATION', source: 'environment' },
		});
		expect(result.runtimeMediatedSecrets).toEqual({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				hosts: ['api.linear.app'],
				value: 'linear-token',
			},
			AGENT_VM_MCP_NOTION_AUTHORIZATION: {
				hosts: ['api.notion.com'],
				value: 'notion-token',
			},
		});
		expect(secretResolver.resolveAllMock).toHaveBeenCalledWith({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				ref: 'op://agent-vm/linear/credential',
				source: '1password',
			},
			AGENT_VM_MCP_NOTION_AUTHORIZATION: {
				ref: 'op://agent-vm/notion/credential',
				source: '1password',
			},
		});
	});

	it('reports both source secrets when normalized provider secret names collide', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					linear: {
						kind: 'mcp',
						namespace: 'linear',
						secretPolicies: {
							'api-key': { hosts: ['api.linear.app'], injection: 'http-mediation' },
							api_key: { hosts: ['api.linear.app'], injection: 'http-mediation' },
						},
						transport: {
							headers: {
								'api-key': {
									ref: 'op://agent-vm/linear/api-key',
									source: '1password',
								},
								api_key: {
									ref: 'op://agent-vm/linear/api_key',
									source: '1password',
								},
							},
							kind: 'streamable-http',
							url: 'https://api.linear.app/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
		});

		await expect(
			planMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: createSecretResolver({}),
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/api-key.*api_key|api_key.*api-key/u);
	});

	it('rejects authored environment provider secrets unless the generated env name is allowlisted', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					linear: {
						kind: 'mcp',
						namespace: 'linear',
						secretPolicies: {
							authorization: { hosts: [], injection: 'env' },
						},
						transport: {
							headers: {
								authorization: {
									name: 'LINEAR_MCP_TOKEN',
									source: 'environment',
								},
							},
							kind: 'streamable-http',
							url: 'https://api.linear.app/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
		});
		const effectiveDir = path.join(authoredDir, 'effective');
		const secretResolver = createSecretResolver({
			LINEAR_MCP_TOKEN: 'linear-env-token',
		});

		await expect(
			writeMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: effectiveDir,
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/AGENT_VM_MCP_LINEAR_AUTHORIZATION.*rawEnvSecrets/u);
	});

	it('materializes explicitly allowlisted environment provider secrets through the shared resolver', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					linear: {
						kind: 'mcp',
						namespace: 'linear',
						secretPolicies: {
							authorization: { hosts: [], injection: 'env' },
						},
						transport: {
							headers: {
								authorization: {
									name: 'LINEAR_MCP_TOKEN',
									source: 'environment',
								},
							},
							kind: 'streamable-http',
							url: 'https://api.linear.app/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
		});
		const effectiveDir = path.join(authoredDir, 'effective');
		const secretResolver = createSecretResolver({
			LINEAR_MCP_TOKEN: 'linear-env-token',
		});

		const result = await writeMcpPortalEffectiveConfig({
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
			allowedRawEnvSecretNames: ['AGENT_VM_MCP_LINEAR_AUTHORIZATION'],
			secretResolver,
			zoneId: 'shravan',
		});
		const effectiveMcpConfig = await readEffectiveMcpConfig<{
			readonly providers: Record<string, { readonly transport: { readonly headers: unknown } }>;
		}>(effectiveDir);

		expect(effectiveMcpConfig.providers.linear?.transport.headers).toEqual({
			authorization: { name: 'AGENT_VM_MCP_LINEAR_AUTHORIZATION', source: 'environment' },
		});
		expect(result.runtimeEnvironment).toEqual({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: 'linear-env-token',
		});
		expect(result.runtimeMediatedSecrets).toEqual({});
		expect(secretResolver.resolveAllMock).toHaveBeenCalledWith({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				ref: 'LINEAR_MCP_TOKEN',
				source: 'environment',
			},
		});
	});

	it('rejects missing resolved provider secret values', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					tavily: {
						kind: 'mcp',
						namespace: 'tavily',
						secretPolicies: {
							TAVILY_API_KEY: { hosts: ['api.tavily.com'], injection: 'http-mediation' },
						},
						transport: {
							args: ['-y', 'tavily-mcp'],
							command: 'npx',
							env: {
								TAVILY_API_KEY: {
									ref: 'op://agent-vm/tavily/credential',
									source: '1password',
								},
							},
							kind: 'stdio',
							networkAccess: 'declared',
							requiredEgressHosts: ['api.tavily.com'],
						},
					},
				},
				schemaVersion: 1,
			},
		});
		const emptyResolver = {
			resolve: async () => {
				throw new Error('not used');
			},
			resolveAll: vi.fn(async () => ({})),
		} satisfies SecretResolver;

		await expect(
			writeMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				secretResolver: emptyResolver,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/AGENT_VM_MCP_TAVILY_TAVILY_API_KEY/u);
	});

	it('rejects empty resolved provider secret values', async () => {
		const authoredDir = await createAuthoredDir({
			mcpConfig: {
				providers: {
					tavily: {
						kind: 'mcp',
						namespace: 'tavily',
						secretPolicies: {
							TAVILY_API_KEY: { hosts: [], injection: 'env' },
						},
						transport: {
							args: ['-y', 'tavily-mcp'],
							command: 'npx',
							env: {
								TAVILY_API_KEY: {
									ref: 'op://agent-vm/tavily/credential',
									source: '1password',
								},
							},
							kind: 'stdio',
							networkAccess: 'declared',
							requiredEgressHosts: ['api.tavily.com'],
						},
					},
				},
				schemaVersion: 1,
			},
		});
		const emptyValueResolver = {
			resolve: async () => {
				throw new Error('not used');
			},
			resolveAll: vi.fn(async () => ({ AGENT_VM_MCP_TAVILY_TAVILY_API_KEY: '' })),
		} satisfies SecretResolver;

		await expect(
			writeMcpPortalEffectiveConfig({
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
				allowedRawEnvSecretNames: ['AGENT_VM_MCP_TAVILY_TAVILY_API_KEY'],
				secretResolver: emptyValueResolver,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/AGENT_VM_MCP_TAVILY_TAVILY_API_KEY/u);
	});
});
