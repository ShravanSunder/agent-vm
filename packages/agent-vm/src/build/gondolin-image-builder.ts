import path from 'node:path';

import {
	buildImage as buildImageFromCore,
	computeBuildFingerprint,
	type BuildConfig,
	type BuildImageOptions,
	type BuildImageResult,
} from '@agent-vm/gondolin-adapter';

import { loadSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { TaskOutput } from '../shared/run-task.js';
import { resolveRuntimeBuildVersionTag as resolveRuntimeBuildVersionTagDefault } from './runtime-versions.js';

export interface GondolinImageBuilderDependencies {
	readonly buildImage?: (
		options: BuildImageOptions,
		dependencies?: { readonly gondolinVersion?: string },
	) => Promise<BuildImageResult>;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<BuildConfig>;
	readonly resolveRuntimeBuildVersionTag?: () => Promise<string>;
}

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<BuildConfig> {
	try {
		return (await loadJsonConfigFile(buildConfigPath)) as BuildConfig;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			throw new Error(`Failed to read build config '${buildConfigPath}': ${message}`, {
				cause: error,
			});
		}
		throw new Error(`Failed to parse build config '${buildConfigPath}': ${message}`, {
			cause: error,
		});
	}
}

export async function computeFingerprintFromConfigPath(
	buildConfigPath: string,
	systemCacheIdentifierPath: string,
	dependencies: Pick<GondolinImageBuilderDependencies, 'resolveRuntimeBuildVersionTag'> = {},
): Promise<string> {
	const buildConfig = await loadBuildConfigFromJson(buildConfigPath);
	const fingerprintInput = await loadSystemCacheIdentifier({ filePath: systemCacheIdentifierPath });
	const runtimeBuildVersionTag = await (
		dependencies.resolveRuntimeBuildVersionTag ?? resolveRuntimeBuildVersionTagDefault
	)();

	return computeBuildFingerprint(buildConfig, runtimeBuildVersionTag, fingerprintInput);
}

export async function buildGondolinImage(
	options: {
		readonly buildConfigPath: string;
		readonly systemCacheIdentifierPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
		readonly streamPreview?: TaskOutput;
	},
	dependencies: GondolinImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
	const buildImage = dependencies.buildImage ?? buildImageFromCore;
	const configDir = path.dirname(path.resolve(options.buildConfigPath));
	const buildConfig = await loadBuildConfig(options.buildConfigPath);
	const fingerprintInput = await loadSystemCacheIdentifier({
		filePath: options.systemCacheIdentifierPath,
	});
	const runtimeBuildVersionTag = await (
		dependencies.resolveRuntimeBuildVersionTag ?? resolveRuntimeBuildVersionTagDefault
	)();

	return await buildImage(
		{
			buildConfig,
			cacheDir: options.cacheDir,
			configDir,
			fingerprintInput,
			...(options.streamPreview ? { output: options.streamPreview } : {}),
			...(options.fullReset ? { fullReset: true } : {}),
		},
		{
			gondolinVersion: runtimeBuildVersionTag,
		},
	);
}
