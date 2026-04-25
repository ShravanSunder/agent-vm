import fs from 'node:fs/promises';
import path from 'node:path';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import {
	deleteStaleImageDirectories as deleteStaleImageDirectoriesDefault,
	findStaleImageDirectories as findStaleImageDirectoriesDefault,
	type StaleImageEntry,
} from '../build/stale-image-cleaner.js';
import type { LoadedSystemConfig } from '../config/system-config.js';

interface CacheCommandIo {
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

interface CacheEntry {
	readonly current: boolean;
	readonly fingerprint: string;
}

type ImageProfileFamily = 'gateway' | 'toolVm';

interface CurrentImageFingerprints {
	readonly gateways: Record<string, string>;
	readonly toolVms: Record<string, string>;
}

function recordFromEntries<TValue>(
	entries: readonly (readonly [string, TValue])[],
): Record<string, TValue> {
	return Object.fromEntries(entries) as Record<string, TValue>;
}

export interface CacheCommandDependencies {
	readonly computeFingerprintFromConfigPath?: (
		buildConfigPath: string,
		systemCacheIdentifierPath: string,
	) => Promise<string>;
	readonly deleteStaleImageDirectories?: (entries: readonly StaleImageEntry[]) => Promise<void>;
	readonly findStaleImageDirectories?: (options: {
		readonly cacheDir: string;
		readonly currentFingerprints: CurrentImageFingerprints;
	}) => Promise<readonly StaleImageEntry[]>;
	readonly listCacheEntries?: (
		cacheDir: string,
		family: ImageProfileFamily,
		profileName: string,
		currentFingerprint: string,
	) => Promise<readonly CacheEntry[]>;
}

export function imageProfileCacheDirectoryName(family: ImageProfileFamily): string {
	return family === 'gateway' ? 'gateway-images' : 'tool-vm-images';
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

async function listCacheEntries(
	cacheDir: string,
	family: ImageProfileFamily,
	profileName: string,
	currentFingerprint: string,
): Promise<readonly CacheEntry[]> {
	const typeDirectory = path.join(cacheDir, imageProfileCacheDirectoryName(family), profileName);
	let entries: { readonly name: string; isDirectory(): boolean }[];
	try {
		entries = await fs.readdir(typeDirectory, { withFileTypes: true });
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}

	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			current: entry.name === currentFingerprint,
			fingerprint: entry.name,
		}));
}

async function resolveCurrentFingerprints(
	systemConfig: LoadedSystemConfig,
	dependencies: Pick<CacheCommandDependencies, 'computeFingerprintFromConfigPath'>,
): Promise<CurrentImageFingerprints> {
	const computeFingerprint =
		dependencies.computeFingerprintFromConfigPath ?? computeFingerprintFromConfigPath;
	const systemCacheIdentifierPath = systemConfig.systemCacheIdentifierPath;

	return {
		gateways: recordFromEntries(
			await Promise.all(
				Object.entries(systemConfig.imageProfiles.gateways).map(async ([profileName, profile]) => [
					profileName,
					await computeFingerprint(profile.buildConfig, systemCacheIdentifierPath),
				]),
			),
		),
		toolVms: recordFromEntries(
			await Promise.all(
				Object.entries(systemConfig.imageProfiles.toolVms).map(async ([profileName, profile]) => [
					profileName,
					await computeFingerprint(profile.buildConfig, systemCacheIdentifierPath),
				]),
			),
		),
	};
}

async function listEntriesByProfile(options: {
	readonly cacheDir: string;
	readonly currentFingerprints: Record<string, string>;
	readonly family: ImageProfileFamily;
	readonly listEntries: NonNullable<CacheCommandDependencies['listCacheEntries']>;
}): Promise<Record<string, readonly CacheEntry[]>> {
	return recordFromEntries<readonly CacheEntry[]>(
		await Promise.all(
			Object.entries(options.currentFingerprints).map(async ([profileName, currentFingerprint]) => [
				profileName,
				await options.listEntries(
					options.cacheDir,
					options.family,
					profileName,
					currentFingerprint,
				),
			]),
		),
	);
}

export async function runCacheCommand(
	options: {
		readonly confirm?: boolean;
		readonly subcommand: string;
		readonly systemConfig: LoadedSystemConfig;
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
					gateways: await listEntriesByProfile({
						cacheDir: options.systemConfig.cacheDir,
						currentFingerprints: currentFingerprints.gateways,
						family: 'gateway',
						listEntries,
					}),
					toolVms: await listEntriesByProfile({
						cacheDir: options.systemConfig.cacheDir,
						currentFingerprints: currentFingerprints.toolVms,
						family: 'toolVm',
						listEntries,
					}),
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
		const staleEntries = await findStaleDirectories({
			cacheDir: options.systemConfig.cacheDir,
			currentFingerprints,
		});

		if (staleEntries.length === 0) {
			io.stderr.write('[cache] No stale images found.\n');
			return;
		}

		io.stderr.write(`[cache] ${staleEntries.length} stale image(s):\n`);
		for (const entry of staleEntries) {
			io.stderr.write(
				`  ${imageProfileCacheDirectoryName(entry.family)}/${entry.profileName}/${entry.fingerprint} (${formatBytes(entry.sizeBytes)})\n`,
			);
		}

		if (!options.confirm) {
			io.stderr.write('\n[cache] Run with --confirm to delete. Stop the controller first.\n');
			return;
		}

		const deleteStaleDirectories =
			dependencies.deleteStaleImageDirectories ?? deleteStaleImageDirectoriesDefault;
		await deleteStaleDirectories(staleEntries);
		io.stderr.write(`[cache] Deleted ${staleEntries.length} stale image(s).\n`);
		return;
	}

	throw new Error(`Unknown cache subcommand '${options.subcommand}'.`);
}
