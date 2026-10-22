import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const legacyIntegrity =
	'sha512-IMzAWXVPTh++vruqIRKws7e7D4mbFn6T94RYLXV3p3Wjy6ITaDBe9tlpCbeOdlplLc63TGJmDIyL9wURkEMhjw==';
const configIntegrity =
	'sha512-pQuYQnp90VETQ6EO0w5iBS0pdYD9kCShJZQ9/enyp2ZXhspdocShrVRjAQaBx+8n+hbz9XgxaLgWWiim/9Ge0w==';

function assertLockedIntegrity(lockfile: string, packageName: string, expected: string): void {
	const lines = lockfile.split('\n');
	const start = lines.indexOf(`  '${packageName}@0.0.153':`);
	if (start < 0) throw new Error(`Legacy oracle lock entry missing: ${packageName}`);
	const block: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('  ') && line[2] !== ' ' && line.trim() !== '') break;
		block.push(line);
	}
	const actual = block.join('\n').match(/\bintegrity:\s*([^}\s]+)/u)?.[1];
	if (actual !== expected) throw new Error(`Legacy oracle integrity mismatch: ${packageName}`);
}

export function assertPinnedLegacyArtifacts(props: {
	readonly aliasSpecifier: unknown;
	readonly legacyManifest: unknown;
	readonly configManifest: unknown;
	readonly legacyDirectory: string;
	readonly configDirectory: string;
	readonly workspaceDirectory: string;
	readonly lockfile: string;
}): void {
	z.literal('npm:@agent-vm/mcp-portal@0.0.153').parse(props.aliasSpecifier);
	z.object({
		name: z.literal('@agent-vm/mcp-portal'),
		version: z.literal('0.0.153'),
		dependencies: z.object({ '@agent-vm/config-contracts': z.literal('0.0.153') }),
	}).parse(props.legacyManifest);
	z.object({ name: z.literal('@agent-vm/config-contracts'), version: z.literal('0.0.153') }).parse(
		props.configManifest,
	);
	const packages = path.join(props.workspaceDirectory, 'packages') + path.sep;
	if (props.legacyDirectory.startsWith(packages) || props.configDirectory.startsWith(packages))
		throw new Error(
			'Legacy oracle must resolve installed registry artifacts, not workspace source',
		);
	assertLockedIntegrity(props.lockfile, '@agent-vm/mcp-portal', legacyIntegrity);
	assertLockedIntegrity(props.lockfile, '@agent-vm/config-contracts', configIntegrity);
}

async function optionalJson(location: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(location, 'utf8'));
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

interface ManifestOwner {
	readonly directory: string;
	readonly manifest: unknown;
}

async function owningManifest(directory: string): Promise<ManifestOwner> {
	const manifest = await optionalJson(path.join(directory, 'package.json'));
	if (z.object({ name: z.string() }).safeParse(manifest).success)
		return { directory: await realpath(directory), manifest };
	const parent = path.dirname(directory);
	if (parent === directory) throw new Error('Missing legacy oracle package manifest');
	return await owningManifest(parent);
}

async function legacyConfigManifest(lookup: readonly string[]): Promise<ManifestOwner> {
	const directory = lookup[0];
	if (directory === undefined) throw new Error('Missing legacy oracle config-contracts dependency');
	const location = path.join(directory, '@agent-vm/config-contracts/package.json');
	const manifest = await optionalJson(location);
	if (manifest !== undefined)
		return { directory: await realpath(path.dirname(location)), manifest };
	return await legacyConfigManifest(lookup.slice(1));
}

/** Released0.0.153 from8535fdd4 has oracle source dirs byte-identical to08f9e426. */
export async function assertLegacyProxyArtifact(): Promise<void> {
	const legacyEntry = fileURLToPath(import.meta.resolve('legacy-mcp-portal/core'));
	const legacy = await owningManifest(path.dirname(legacyEntry));
	const lookup = createRequire(legacyEntry).resolve.paths('@agent-vm/config-contracts') ?? [];
	const config = await legacyConfigManifest(lookup);
	const workspaceDirectory = fileURLToPath(new URL('../../../../', import.meta.url));
	const hostManifest = z
		.object({ devDependencies: z.record(z.string(), z.unknown()) })
		.parse(await optionalJson(fileURLToPath(new URL('../../package.json', import.meta.url))));
	assertPinnedLegacyArtifacts({
		aliasSpecifier: hostManifest.devDependencies['legacy-mcp-portal'],
		legacyManifest: legacy.manifest,
		configManifest: config.manifest,
		legacyDirectory: legacy.directory,
		configDirectory: config.directory,
		workspaceDirectory,
		lockfile: await readFile(path.join(workspaceDirectory, 'pnpm-lock.yaml'), 'utf8'),
	});
}
