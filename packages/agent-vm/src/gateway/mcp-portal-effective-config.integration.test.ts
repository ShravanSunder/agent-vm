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
const effectiveConfigManifestFileName = 'mcp-portal-effective-manifest.json';
type TestSecretResolver = SecretResolver & { readonly resolveAllMock: ReturnType<typeof vi.fn> };

interface TestEffectiveConfigManifest {
	readonly mcpConfigFile: string;
	readonly portalConfigFile: string;
	readonly schemaVersion: 1;
}

afterAll(async () => {
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
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
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
		});
		const effectiveDir = path.join(authoredDir, 'effective');

		await writeMcpPortalEffectiveConfig({
			authoredConfigDir: authoredDir,
			effectiveHostConfigDir: effectiveDir,
			effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective',
			secretResolver: emptySecretResolver,
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
});
