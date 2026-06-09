import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SecretResolver } from '@agent-vm/secret-management';
import { afterAll, describe, expect, it } from 'vitest';

import { writeMcpPortalEffectiveConfig } from './mcp-portal-effective-config.js';

const createdDirectories: string[] = [];
const effectiveConfigManifestFileName = 'mcp-portal-effective-manifest.json';

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

describe('MCP Portal effective config file materialization', () => {
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
