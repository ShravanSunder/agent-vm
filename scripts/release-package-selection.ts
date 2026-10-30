/// <reference types="node" />
/// <reference lib="es2023.array" />
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ReleaseManifestSource {
	readonly directoryName: string;
	readonly manifest: Readonly<Record<string, unknown>>;
}

export interface NpmReleasePackage {
	readonly name: string;
	readonly version: string;
	readonly manifestPath: string;
	readonly tarballName: string;
}

function isManifestRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isReleasePackageName(packageName: unknown): packageName is string {
	return (
		typeof packageName === 'string' &&
		(packageName.startsWith('@agent-vm/') || packageName.startsWith('@agent-collaboration/'))
	);
}

export function releaseTarballName(packageName: string, packageVersion: string): string {
	return `${packageName.replace(/^@/u, '').replace('/', '-')}-${packageVersion}.tgz`;
}

export function selectReleasePackages(
	manifestSources: readonly ReleaseManifestSource[],
): readonly NpmReleasePackage[] {
	const releasePackages: NpmReleasePackage[] = [];
	for (const { directoryName, manifest } of manifestSources) {
		if (!isReleasePackageName(manifest.name) || manifest.private === true) continue;
		if (typeof manifest.version !== 'string') {
			throw new Error(`${manifest.name}: version must be a string`);
		}
		const repository = manifest.repository;
		if (
			typeof repository !== 'object' ||
			repository === null ||
			!('url' in repository) ||
			repository.url !== 'git+https://github.com/ShravanSunder/agent-vm.git' ||
			!('directory' in repository) ||
			repository.directory !== `packages/${directoryName}`
		) {
			throw new Error(
				`${manifest.name}: repository.url must be git+https://github.com/ShravanSunder/agent-vm.git and repository.directory must be packages/${directoryName}`,
			);
		}
		releasePackages.push({
			name: manifest.name,
			version: manifest.version,
			manifestPath: `packages/${directoryName}/package.json`,
			tarballName: releaseTarballName(manifest.name, manifest.version),
		});
	}
	return releasePackages;
}

export async function listReleasePackages(
	repositoryRoot: string,
): Promise<readonly NpmReleasePackage[]> {
	const packageDirectories = (
		await readdir(path.join(repositoryRoot, 'packages'), { withFileTypes: true })
	)
		.filter((directoryEntry) => directoryEntry.isDirectory())
		.map((directoryEntry) => directoryEntry.name)
		.toSorted();
	const manifestSources = (
		await Promise.all(
			packageDirectories.map(async (directoryName): Promise<ReleaseManifestSource | undefined> => {
				let sourceText: string;
				try {
					sourceText = await readFile(
						path.join(repositoryRoot, 'packages', directoryName, 'package.json'),
						'utf8',
					);
				} catch (error: unknown) {
					if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
						return undefined;
					throw error;
				}
				const manifest: unknown = JSON.parse(sourceText);
				if (!isManifestRecord(manifest)) {
					throw new Error(`packages/${directoryName}/package.json must contain a JSON object`);
				}
				return { directoryName, manifest };
			}),
		)
	).filter(
		(manifestSource): manifestSource is ReleaseManifestSource => manifestSource !== undefined,
	);
	return selectReleasePackages(manifestSources);
}

async function main(): Promise<void> {
	const outputFormat = process.argv[2];
	if (outputFormat !== 'versions' && outputFormat !== 'artifacts') {
		throw new Error('Usage: node scripts/release-package-selection.ts <versions|artifacts>');
	}
	// Collect and validate every package before writing any rows for the publisher.
	const releasePackages = await listReleasePackages(process.cwd());
	if (releasePackages.length === 0)
		throw new Error('No publishable release packages found under packages/');
	for (const releasePackage of releasePackages) {
		const columns =
			outputFormat === 'versions'
				? [releasePackage.version, releasePackage.name, releasePackage.manifestPath]
				: [releasePackage.name, releasePackage.tarballName];
		process.stdout.write(`${columns.join('\t')}\n`);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
