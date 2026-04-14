import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildImage as buildImageFromCore,
	computeBuildFingerprint,
	type BuildConfig,
	type BuildImageOptions,
	type BuildImageResult,
} from '@shravansunder/gondolin-core';

export interface GondolinImageBuilderDependencies {
	readonly buildImage?: (options: BuildImageOptions) => Promise<BuildImageResult>;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<BuildConfig>;
}

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<BuildConfig> {
	const rawContents = await fs.readFile(buildConfigPath, 'utf8');
	return JSON.parse(rawContents) as BuildConfig;
}

export async function computeFingerprintFromConfigPath(buildConfigPath: string): Promise<string> {
	const buildConfig = await loadBuildConfigFromJson(buildConfigPath);
	return computeBuildFingerprint(buildConfig);
}

export async function buildGondolinImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
	},
	dependencies: GondolinImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
	const buildImage = dependencies.buildImage ?? buildImageFromCore;
	const configDir = path.dirname(path.resolve(options.buildConfigPath));
	const buildConfig = await loadBuildConfig(options.buildConfigPath);

	return await buildImage({
		buildConfig,
		cacheDir: options.cacheDir,
		configDir,
		...(options.fullReset ? { fullReset: true } : {}),
	});
}
