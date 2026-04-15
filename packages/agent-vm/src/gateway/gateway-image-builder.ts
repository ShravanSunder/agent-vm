import fs from 'node:fs/promises';

import type { BuildConfig, BuildImageResult } from '@shravansunder/gondolin-core';

import {
	buildGondolinImage as buildGondolinImageDefault,
	type GondolinImageBuilderDependencies,
} from '../build/gondolin-image-builder.js';
import type { GatewayBuildImageOptions } from './gateway-zone-support.js';

export interface GatewayImageBuilderDependencies {
	readonly buildImage?: (options: GatewayBuildImageOptions) => Promise<BuildImageResult>;
	readonly buildGondolinImage?: GondolinImageBuilderDependencies['buildImage'];
	readonly loadBuildConfig?: GondolinImageBuilderDependencies['loadBuildConfig'];
}

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<BuildConfig> {
	return JSON.parse(await fs.readFile(buildConfigPath, 'utf8')) as BuildConfig;
}

export async function buildGatewayImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
	},
	dependencies: GatewayImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	if (dependencies.buildImage) {
		const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
		return await dependencies.buildImage({
			buildConfig: await loadBuildConfig(options.buildConfigPath),
			cacheDir: options.cacheDir,
		});
	}

	return await buildGondolinImageDefault(options, {
		...(dependencies.buildGondolinImage ? { buildImage: dependencies.buildGondolinImage } : {}),
		...(dependencies.loadBuildConfig ? { loadBuildConfig: dependencies.loadBuildConfig } : {}),
	});
}
