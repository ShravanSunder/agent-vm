import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildImageResult } from 'gondolin-core';
import { z } from 'zod';

import { buildDockerImage as buildDockerImageDefault } from '../build/docker-image-builder.js';
import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { SystemConfig } from '../controller/system-config.js';
import type { CliIo } from './agent-vm-cli-support.js';

export interface BuildCommandDependencies {
	readonly buildDockerImage?: (options: {
		readonly dockerfilePath: string;
		readonly imageTag: string;
	}) => Promise<void>;
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
	}) => Promise<BuildImageResult>;
	readonly resolveOciImageTag?: (buildConfigPath: string) => Promise<string>;
}

const ociImageTagSchema = z.object({
	oci: z.object({
		image: z.string().min(1),
	}),
});

interface ImageTarget {
	readonly buildConfigPath: string;
	readonly dockerfile: string | undefined;
	readonly name: 'gateway' | 'tool';
}

async function resolveOciImageTagFromConfig(buildConfigPath: string): Promise<string> {
	const rawConfig: unknown = JSON.parse(await fs.readFile(buildConfigPath, 'utf8'));
	const parsedConfig = ociImageTagSchema.safeParse(rawConfig);
	if (!parsedConfig.success) {
		throw new Error(
			`build-config.json at ${buildConfigPath} has no valid oci.image tag: ${parsedConfig.error.message}`,
		);
	}
	return parsedConfig.data.oci.image;
}

export async function runBuildCommand(
	options: {
		readonly forceRebuild?: boolean;
		readonly systemConfig: SystemConfig;
	},
	io: CliIo,
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	const buildDockerImage = dependencies.buildDockerImage ?? buildDockerImageDefault;
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const resolveOciImageTag = dependencies.resolveOciImageTag ?? resolveOciImageTagFromConfig;

	const imageTargets: readonly ImageTarget[] = [
		{
			buildConfigPath: options.systemConfig.images.gateway.buildConfig,
			dockerfile: options.systemConfig.images.gateway.dockerfile,
			name: 'gateway',
		},
		{
			buildConfigPath: options.systemConfig.images.tool.buildConfig,
			dockerfile: options.systemConfig.images.tool.dockerfile,
			name: 'tool',
		},
	];

	for (const imageTarget of imageTargets) {
		if (!imageTarget.dockerfile) {
			continue;
		}

		const imageTag = await resolveOciImageTag(imageTarget.buildConfigPath);
		io.stderr.write(`[build] Docker: ${imageTarget.name} -> ${imageTag}\n`);
		await buildDockerImage({
			dockerfilePath: imageTarget.dockerfile,
			imageTag,
		});
		io.stderr.write(`[build] Docker: ${imageTarget.name} done\n`);
	}

	for (const imageTarget of imageTargets) {
		const cacheDirectory = path.join(options.systemConfig.cacheDir, 'images', imageTarget.name);
		io.stderr.write(`[build] Gondolin: ${imageTarget.name} -> ${cacheDirectory}\n`);
		const buildResult = await buildGondolinImage({
			buildConfigPath: imageTarget.buildConfigPath,
			cacheDir: cacheDirectory,
			...(options.forceRebuild !== undefined ? { fullReset: options.forceRebuild } : {}),
		});
		const buildStatus = buildResult.built ? 'built' : 'cached';
		io.stderr.write(
			`[build] Gondolin: ${imageTarget.name} ${buildStatus} [${buildResult.fingerprint}]\n`,
		);
	}
}
