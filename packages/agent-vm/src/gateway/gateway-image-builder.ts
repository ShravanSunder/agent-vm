import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildImage as buildImageFromCore,
	type BuildImageOptions,
	type BuildImageResult,
} from 'gondolin-core';

import type { GatewayBuildImageOptions } from './gateway-zone-support.js';

export interface GatewayImageBuilderDependencies {
	readonly buildImage?: (options: GatewayBuildImageOptions) => Promise<BuildImageResult>;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<unknown>;
}

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<unknown> {
	const rawContents = await fs.readFile(buildConfigPath, 'utf8');
	return JSON.parse(rawContents);
}

export async function buildGatewayImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
	},
	dependencies: GatewayImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
	const configDir = path.dirname(path.resolve(options.buildConfigPath));
	const buildImage =
		dependencies.buildImage ??
		(async (buildOptions: GatewayBuildImageOptions): Promise<BuildImageResult> => {
			const coreBuildOptions: BuildImageOptions = {
				buildConfig: buildOptions.buildConfig as never,
				cacheDir: buildOptions.cacheDir,
				configDir,
				...(buildOptions.fullReset !== undefined ? { fullReset: buildOptions.fullReset } : {}),
			};

			return await buildImageFromCore(coreBuildOptions);
		});

	return await buildImage({
		buildConfig: await loadBuildConfig(options.buildConfigPath),
		cacheDir: options.cacheDir,
	});
}
