import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildConfig, BuildOptions } from '@earendil-works/gondolin';

export type { BuildConfig } from '@earendil-works/gondolin';

export interface BuildImageOptions {
	readonly buildConfig: BuildConfig;
	readonly cacheDir: string;
	/** Directory to resolve relative paths in buildConfig (e.g. postBuild.copy.src).
	 *  Defaults to process.cwd() if not provided. */
	readonly configDir?: string;
	readonly fullReset?: boolean;
}

export interface BuildImageResult {
	readonly built: boolean;
	readonly fingerprint: string;
	readonly imagePath: string;
}

interface BuildPipelineDependencies {
	readonly buildAssets?: (
		buildConfig: BuildConfig,
		outputDirectory: string,
		configDir?: string,
	) => Promise<unknown>;
	readonly gondolinVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
	}

	if (isRecord(value)) {
		const objectEntries = Object.entries(value)
			.filter(([, entryValue]) => entryValue !== undefined)
			.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
		return `{${objectEntries
			.map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${stableSerialize(entryValue)}`)
			.join(',')}}`;
	}

	return JSON.stringify(value);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function hasBuiltAssets(outputDirectoryPath: string): Promise<boolean> {
	return (
		(await pathExists(path.join(outputDirectoryPath, 'manifest.json'))) &&
		(await pathExists(path.join(outputDirectoryPath, 'rootfs.ext4'))) &&
		(await pathExists(path.join(outputDirectoryPath, 'initramfs.cpio.lz4'))) &&
		(await pathExists(path.join(outputDirectoryPath, 'vmlinuz-virt')))
	);
}

async function loadBuildAssets(): Promise<
	(buildConfig: BuildConfig, outputDirectory: string, configDir?: string) => Promise<unknown>
> {
	const gondolinModule = await import('@earendil-works/gondolin');
	return async (
		buildConfig: BuildConfig,
		outputDirectory: string,
		configDir?: string,
	): Promise<unknown> =>
		await gondolinModule.buildAssets(buildConfig, {
			outputDir: outputDirectory,
			verbose: false,
			...(configDir ? { configDir } : {}),
		} satisfies BuildOptions);
}

export function computeBuildFingerprint(
	buildConfig: BuildConfig,
	gondolinVersion: string = 'unknown',
): string {
	return crypto
		.createHash('sha256')
		.update(`${stableSerialize(buildConfig)}|${gondolinVersion}`)
		.digest('hex')
		.slice(0, 16);
}

export async function buildImage(
	options: BuildImageOptions,
	dependencies: BuildPipelineDependencies = {},
): Promise<BuildImageResult> {
	const fingerprint = computeBuildFingerprint(options.buildConfig, dependencies.gondolinVersion);
	const imagePath = path.join(options.cacheDir, fingerprint);

	if (options.fullReset) {
		await fs.rm(imagePath, { recursive: true, force: true });
	}

	if (await hasBuiltAssets(imagePath)) {
		return {
			built: false,
			fingerprint,
			imagePath,
		};
	}

	await fs.mkdir(imagePath, { recursive: true });
	const buildAssetsImplementation = dependencies.buildAssets ?? (await loadBuildAssets());
	await buildAssetsImplementation(options.buildConfig, imagePath, options.configDir);

	if (!(await hasBuiltAssets(imagePath))) {
		throw new Error(`Expected Gondolin assets to be written to ${imagePath}.`);
	}

	return {
		built: true,
		fingerprint,
		imagePath,
	};
}
