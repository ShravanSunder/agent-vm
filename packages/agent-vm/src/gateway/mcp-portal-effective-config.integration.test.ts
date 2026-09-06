import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
	resolveMcpPortalEffectiveConfig,
	writeMcpPortalEffectiveConfig,
} from './mcp-portal-effective-config.js';

const createdDirectories: string[] = [];
function createEphemeralConfiguredCliToolPortalConfigInput(): unknown {
	return {
		agents: {
			shravan: {
				credentialBindings: {
					google: {
						files: {
							'service-account': {
								ref: 'op://agent-vm-testing/google/service-account',
								source: '1password',
							},
						},
					},
				},
				profile: 'default',
			},
		},
		mode: 'managed',
		profiles: {
			default: {
				namespaces: {
					controller: {
						backend: {
							kind: 'controller_execution',
							operations: {
								isolated: {
									calls: {
										deny: [],
										requiresApproval: [],
										withoutApproval: 'remaining_admitted',
									},
									commands: [{ path: ['run'] }],
									deniedPatterns: [],
									executablePath: '/usr/bin/printf',
									executionTarget: {
										allowedHosts: [],
										credentialProjection: {
											credentialBinding: 'google',
											credentialEnvironment: {
												GOG_DATA_DIR: { kind: 'credential_root' },
											},
											credentialFiles: [
												{
													path: 'sa-c2hyYXZhbkBleGFtcGxlLmNvbQ.json',
													source: 'service-account',
												},
											],
											kind: 'file_binding',
										},
										environment: { kind: 'empty' },
										guestCwd: '/run',
										imageReference: '../../vm-images/controller-runners/default/build-config.json',
										kind: 'ephemeral_managed_vm',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: [],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 1024,
										stdoutMaxBytes: 1024,
									},
									safeHelp: 'Run one isolated operation.',
									stdin: { kind: 'none' },
									timeout: { kind: 'quick' },
								},
							},
						},
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: ['isolated'] },
						},
						tools: { allow: ['isolated'] },
					},
				},
			},
		},
		schemaVersion: 1,
	};
}

describe('path-based configured image preparation', () => {
	it('forwards the shared artifact cache through authored config loading', async () => {
		const authoredConfigDir = await createAuthoredDir({
			mcpConfig: { providers: {}, schemaVersion: 1 },
			toolPortalConfig: createEphemeralConfiguredCliToolPortalConfigInput(),
		});
		const effectiveHostConfigDir = path.join(authoredConfigDir, 'effective');
		const sharedImageCacheDir = path.join(authoredConfigDir, 'shared-images');
		const prepareImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'prepared-image',
			imageReference: '/prepared-image',
		}));

		await writeMcpPortalEffectiveConfig({
			authoredConfigDir,
			approvalAccessConfigured: false,
			effectiveHostConfigDir,
			sharedImageCacheDir,
			managedVmImages: { prepareImage },
			secretResolver: emptySecretResolver,
			zoneId: 'zone-a',
			declaredAgentIds: ['shravan'],
		});

		expect(prepareImage).toHaveBeenCalledWith({
			artifactCacheDirectory: sharedImageCacheDir,
			recipePath: path.resolve(
				authoredConfigDir,
				'../../vm-images/controller-runners/default/build-config.json',
			),
		});
	});
});
const effectiveConfigManifestFileName = 'tool-portal-effective-manifest.json';
type TestSecretResolver = SecretResolver & { readonly resolveAllMock: ReturnType<typeof vi.fn> };

interface TestEffectiveConfigManifest {
	readonly mcpConfigFile: string;
	readonly schemaVersion: 1;
	readonly toolPortalConfigFile: string;
}

afterAll(async () => {
	await Promise.all(
		createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createAuthoredDir(props: {
	readonly mcpConfig: unknown;
	readonly toolPortalConfig?: unknown;
}): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'agent-vm-mcp-portal-authored-'));
	createdDirectories.push(dir);
	await writeFile(path.join(dir, 'mcp.config.jsonc'), JSON.stringify(props.mcpConfig), 'utf8');
	await writeFile(
		path.join(dir, 'tool-portal.config.jsonc'),
		JSON.stringify(
			props.toolPortalConfig ?? {
				agents: { shravan: { profile: 'default' } },
				mode: 'managed',
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			},
		),
		'utf8',
	);
	return dir;
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
		!('toolPortalConfigFile' in manifest)
	) {
		throw new Error('test effective config manifest has unexpected shape');
	}
	const schemaVersion = manifest.schemaVersion;
	const mcpConfigFile = manifest.mcpConfigFile;
	const toolPortalConfigFile = manifest.toolPortalConfigFile;
	if (
		schemaVersion !== 1 ||
		typeof mcpConfigFile !== 'string' ||
		typeof toolPortalConfigFile !== 'string'
	) {
		throw new Error('test effective config manifest has unexpected shape');
	}
	return { mcpConfigFile, schemaVersion, toolPortalConfigFile };
}

const emptySecretResolver = {
	resolve: async () => {
		throw new Error('not used');
	},
	resolveAll: async () => ({}),
} satisfies SecretResolver;

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

describe('MCP Portal effective config file materialization', () => {
	it('rejects a managed config directory containing only standalone MCP Portal policy', async () => {
		const authoredDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-tool-portal-ownership-'));
		createdDirectories.push(authoredDir);
		await writeFile(
			path.join(authoredDir, 'mcp.config.jsonc'),
			JSON.stringify({ providers: {}, schemaVersion: 1 }),
			'utf8',
		);
		await writeFile(
			path.join(authoredDir, 'mcp-portal.config.jsonc'),
			JSON.stringify({
				agents: { shravan: { profile: 'default' } },
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			}),
			'utf8',
		);

		await expect(
			resolveMcpPortalEffectiveConfig({
				approvalAccessConfigured: false,
				authoredConfigDir: authoredDir,
				effectiveHostConfigDir: path.join(authoredDir, 'effective'),
				secretResolver: emptySecretResolver,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/tool-portal\.config\.jsonc/u);
	});

	it('resolves 1Password provider secrets without writing effective configs', async () => {
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

		const result = await resolveMcpPortalEffectiveConfig({
			approvalAccessConfigured: false,
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			secretResolver,
			zoneId: 'shravan',
		});

		expect(secretResolver.resolveAllMock).toHaveBeenCalledTimes(1);
		expect(result.runtimeMediatedSecrets).toEqual({
			AGENT_VM_MCP_TAVILY_TAVILY_API_KEY: {
				hosts: ['api.tavily.com'],
				value: 'resolved-tavily',
			},
		});
		await expect(readdir(effectiveDir)).rejects.toMatchObject({ code: 'ENOENT' });
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
			toolPortalConfig: {
				agents: { shravan: { profile: 'default' } },
				mode: 'managed',
				profiles: {
					default: {
						namespaces: {
							linear: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: '*', deny: [] },
								},
								tools: { allow: '*', deny: [] },
							},
						},
					},
				},
				schemaVersion: 1,
			},
		});
		const effectiveDir = path.join(authoredDir, 'effective');

		await writeMcpPortalEffectiveConfig({
			approvalAccessConfigured: false,
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			secretResolver: emptySecretResolver,
			zoneId: 'shravan',
		});
		const manifest = await readEffectiveConfigManifest(effectiveDir);

		expect(manifest.mcpConfigFile).toMatch(/^mcp\.config\.[0-9a-f-]+\.jsonc$/u);
		expect(manifest.toolPortalConfigFile).toMatch(/^tool-portal\.config\.[0-9a-f-]+\.jsonc$/u);
		await expect(
			readFile(path.join(effectiveDir, manifest.mcpConfigFile), 'utf8'),
		).resolves.toContain('linear');
		await expect(
			readFile(path.join(effectiveDir, manifest.toolPortalConfigFile), 'utf8'),
		).resolves.toContain('"backend"');
	});
});
