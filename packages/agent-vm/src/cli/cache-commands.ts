import fs from 'node:fs';
import path from 'node:path';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import {
	deleteStaleImageDirectories as deleteStaleImageDirectoriesDefault,
	findStaleImageDirectories as findStaleImageDirectoriesDefault,
	type StaleImageEntry,
} from '../build/stale-image-cleaner.js';
import type { SystemConfig } from '../controller/system-config.js';

interface CacheCommandIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

interface CacheEntry {
	readonly current: boolean;
	readonly fingerprint: string;
}

export interface CacheCommandDependencies {
	readonly computeFingerprintFromConfigPath?: (buildConfigPath: string) => Promise<string>;
	readonly deleteStaleImageDirectories?: (entries: readonly StaleImageEntry[]) => void;
	readonly findStaleImageDirectories?: (options: {
		readonly cacheDir: string;
		readonly currentFingerprints: { readonly gateway: string; readonly tool: string };
	}) => readonly StaleImageEntry[];
	readonly listCacheEntries?: (
		cacheDir: string,
		imageType: 'gateway' | 'tool',
		currentFingerprint: string,
	) => readonly CacheEntry[];
}

function formatBytes(sizeBytes: number): string {
	if (sizeBytes < 1024 * 1024) {
		return `${Math.round(sizeBytes / 1024)}KB`;
	}

	if (sizeBytes < 1024 * 1024 * 1024) {
		return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
	}

	return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function listCacheEntries(
	cacheDir: string,
	imageType: 'gateway' | 'tool',
	currentFingerprint: string,
): readonly CacheEntry[] {
	const typeDirectory = path.join(cacheDir, 'images', imageType);
	if (!fs.existsSync(typeDirectory)) {
		return [];
	}

	return fs
		.readdirSync(typeDirectory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			current: entry.name === currentFingerprint,
			fingerprint: entry.name,
		}));
}

async function resolveCurrentFingerprints(
	systemConfig: SystemConfig,
	dependencies: Pick<CacheCommandDependencies, 'computeFingerprintFromConfigPath'>,
): Promise<{ gateway: string; tool: string }> {
	const computeFingerprint =
		dependencies.computeFingerprintFromConfigPath ?? computeFingerprintFromConfigPath;

	return {
		gateway: await computeFingerprint(systemConfig.images.gateway.buildConfig),
		tool: await computeFingerprint(systemConfig.images.tool.buildConfig),
	};
}

export async function runCacheCommand(
	options: {
		readonly confirm?: boolean;
		readonly subcommand: string;
		readonly systemConfig: SystemConfig;
	},
	io: CacheCommandIo,
	dependencies: CacheCommandDependencies = {},
): Promise<void> {
	const currentFingerprints = await resolveCurrentFingerprints(options.systemConfig, dependencies);

	if (options.subcommand === 'list') {
		const listEntries = dependencies.listCacheEntries ?? listCacheEntries;
		io.stdout.write(
			`${JSON.stringify(
				{
					cacheDir: options.systemConfig.cacheDir,
					currentFingerprints,
					gateway: listEntries(
						options.systemConfig.cacheDir,
						'gateway',
						currentFingerprints.gateway,
					),
					tool: listEntries(options.systemConfig.cacheDir, 'tool', currentFingerprints.tool),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	if (options.subcommand === 'clean') {
		const findStaleDirectories =
			dependencies.findStaleImageDirectories ?? findStaleImageDirectoriesDefault;
		const staleEntries = findStaleDirectories({
			cacheDir: options.systemConfig.cacheDir,
			currentFingerprints,
		});

		if (staleEntries.length === 0) {
			io.stderr.write('[cache] No stale images found.\n');
			return;
		}

		io.stderr.write(`[cache] ${staleEntries.length} stale image(s):\n`);
		for (const entry of staleEntries) {
			io.stderr.write(`  ${entry.imageType}/${entry.name} (${formatBytes(entry.sizeBytes)})\n`);
		}

		if (!options.confirm) {
			io.stderr.write('\n[cache] Run with --confirm to delete. Stop the controller first.\n');
			return;
		}

		const deleteStaleDirectories =
			dependencies.deleteStaleImageDirectories ?? deleteStaleImageDirectoriesDefault;
		deleteStaleDirectories(staleEntries);
		io.stderr.write(`[cache] Deleted ${staleEntries.length} stale image(s).\n`);
		return;
	}

	throw new Error(`Unknown cache subcommand '${options.subcommand}'.`);
}
