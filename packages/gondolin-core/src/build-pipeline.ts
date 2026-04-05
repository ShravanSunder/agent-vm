import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BuildConfig, BuildOptions } from '@earendil-works/gondolin';

type BuildConfigLike = BuildConfig | Record<string, unknown>;

export interface BuildImageOptions {
	readonly buildConfig: BuildConfigLike;
	readonly cacheDir: string;
	readonly fullReset?: boolean;
}

export interface BuildImageResult {
	readonly built: boolean;
	readonly fingerprint: string;
	readonly imagePath: string;
}

interface BuildPipelineDependencies {
	readonly buildAssets?:
		| ((outputDirectory: string) => Promise<void>)
		| ((buildConfig: BuildConfigLike, outputDirectory: string) => Promise<void>);
	readonly gondolinVersion?: string;
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
	}

	if (typeof value === 'object' && value !== null) {
		const objectEntries = Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue !== undefined)
			.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
		return `{${objectEntries
			.map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${stableSerialize(entryValue)}`)
			.join(',')}}`;
	}

	return JSON.stringify(value);
}

function hasBuiltAssets(outputDirectoryPath: string): boolean {
	return (
		fs.existsSync(path.join(outputDirectoryPath, 'manifest.json')) &&
		fs.existsSync(path.join(outputDirectoryPath, 'rootfs.ext4')) &&
		fs.existsSync(path.join(outputDirectoryPath, 'initramfs.cpio.lz4')) &&
		fs.existsSync(path.join(outputDirectoryPath, 'vmlinuz-virt'))
	);
}

export function computeBuildFingerprint(
	buildConfig: BuildConfigLike,
	gondolinVersion: string = 'unknown',
): string {
	return crypto
		.createHash('sha256')
		.update(`${stableSerialize(buildConfig)}|${gondolinVersion}`)
		.digest('hex')
		.slice(0, 16);
}

async function loadBuildAssets(): Promise<
	(buildConfig: BuildConfig, buildOptions: BuildOptions) => Promise<void>
> {
	const gondolinModule = await import('@earendil-works/gondolin');
	return async (buildConfig: BuildConfig, buildOptions: BuildOptions): Promise<void> => {
		await gondolinModule.buildAssets(buildConfig, buildOptions);
	};
}

export async function buildImage(
	options: BuildImageOptions,
	dependencies: BuildPipelineDependencies = {},
): Promise<BuildImageResult> {
	const fingerprint = computeBuildFingerprint(options.buildConfig, dependencies.gondolinVersion);
	const imagePath = path.join(options.cacheDir, fingerprint);

	if (options.fullReset) {
		fs.rmSync(imagePath, { recursive: true, force: true });
	}

	if (hasBuiltAssets(imagePath)) {
		return {
			built: false,
			fingerprint,
			imagePath,
		};
	}

	fs.mkdirSync(imagePath, { recursive: true });
	if (dependencies.buildAssets) {
		if (dependencies.buildAssets.length >= 2) {
			await (
				dependencies.buildAssets as (
					buildConfig: BuildConfigLike,
					outputDirectory: string,
				) => Promise<void>
			)(options.buildConfig, imagePath);
		} else {
			await (dependencies.buildAssets as (outputDirectory: string) => Promise<void>)(
				imagePath,
			);
		}
	} else {
		const buildAssets = await loadBuildAssets();
		await buildAssets(options.buildConfig as unknown as BuildConfig, {
			outputDir: imagePath,
			verbose: false,
		} satisfies BuildOptions);
	}

	return {
		built: true,
		fingerprint,
		imagePath,
	};
}
