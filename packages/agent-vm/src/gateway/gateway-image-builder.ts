import type { BuildConfig, BuildImageResult } from '@agent-vm/gondolin-adapter';

import {
	buildGondolinImage as buildGondolinImageDefault,
	type GondolinImageBuilderDependencies,
} from '../build/gondolin-image-builder.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { GatewayBuildImageOptions } from './gateway-zone-support.js';

export interface GatewayImageBuilderDependencies {
	readonly buildImage?: (options: GatewayBuildImageOptions) => Promise<BuildImageResult>;
	readonly buildGondolinImage?: GondolinImageBuilderDependencies['buildImage'];
	readonly loadBuildConfig?: GondolinImageBuilderDependencies['loadBuildConfig'];
}

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<BuildConfig> {
	return (await loadJsonConfigFile(buildConfigPath)) as BuildConfig;
}

export async function buildGatewayImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
	},
	dependencies: GatewayImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	const buildImage = dependencies.buildImage;
	if (buildImage) {
		const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
		return await buildGondolinImageDefault(
			{
				buildConfigPath: options.buildConfigPath,
				cacheDir: options.cacheDir,
			},
			{
				buildImage: async (buildImageOptions) =>
					await buildImage({
						buildConfig: buildImageOptions.buildConfig,
						cacheDir: buildImageOptions.cacheDir,
						...(buildImageOptions.fullReset ? { fullReset: true } : {}),
					}),
				loadBuildConfig,
			},
		);
	}

	return await buildGondolinImageDefault(
		{
			buildConfigPath: options.buildConfigPath,
			cacheDir: options.cacheDir,
		},
		{
			...(dependencies.buildGondolinImage ? { buildImage: dependencies.buildGondolinImage } : {}),
			...(dependencies.loadBuildConfig ? { loadBuildConfig: dependencies.loadBuildConfig } : {}),
		},
	);
}
