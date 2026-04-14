import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildImageResult } from '@shravansunder/agent-vm-gondolin-core';
import task from 'tasuku';
import { z } from 'zod';

import { buildDockerImage as buildDockerImageDefault } from '../build/docker-image-builder.js';
import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { SystemConfig } from '../config/system-config.js';
import { formatZodError } from './format-zod-error.js';
import { syncBundledOpenClawPluginBundle } from './openclaw-plugin-bundle.js';

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
	/** Override the task runner for testing (bypasses tasuku terminal rendering). */
	readonly runTask?: (title: string, fn: () => Promise<void>) => Promise<void>;
	readonly resolveProjectRootFromDockerfile?: (dockerfilePath: string) => Promise<string>;
	readonly syncBundledOpenClawPlugin?: (targetDir: string) => Promise<'created' | 'skipped'>;
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
			formatZodError(`Invalid build-config.json at ${buildConfigPath}:`, parsedConfig.error),
		);
	}
	return parsedConfig.data.oci.image;
}

async function defaultRunTask(title: string, fn: () => Promise<void>): Promise<void> {
	await task(title, async (taskState) => {
		taskState.startTime();
		await fn();
		taskState.setTitle(`${title} done`);
	});
}

async function resolveProjectRootFromDockerfile(dockerfilePath: string): Promise<string> {
	let searchDirectory = path.dirname(path.resolve(dockerfilePath));

	for (;;) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- upward root discovery is intentionally sequential
			await fs.access(path.join(searchDirectory, 'config', 'system.json'));
			return searchDirectory;
		} catch {
			const parentDirectory = path.dirname(searchDirectory);
			if (parentDirectory === searchDirectory) {
				// Fallback for older test scaffolds and legacy layouts that still follow the
				// standard images/gateway/Dockerfile shape but do not materialize config/system.json.
				return path.resolve(dockerfilePath, '..', '..', '..');
			}
			searchDirectory = parentDirectory;
		}
	}
}

export async function runBuildCommand(
	options: {
		readonly forceRebuild?: boolean;
		readonly systemConfig: SystemConfig;
	},
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	const buildDockerImage = dependencies.buildDockerImage ?? buildDockerImageDefault;
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const resolveOciImageTag = dependencies.resolveOciImageTag ?? resolveOciImageTagFromConfig;
	const runTaskStep = dependencies.runTask ?? defaultRunTask;
	const resolveProjectRoot =
		dependencies.resolveProjectRootFromDockerfile ?? resolveProjectRootFromDockerfile;
	const syncBundledOpenClawPlugin =
		dependencies.syncBundledOpenClawPlugin ?? syncBundledOpenClawPluginBundle;

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
	const dockerImageTargets = imageTargets.filter(
		(imageTarget): imageTarget is ImageTarget & { readonly dockerfile: string } =>
			imageTarget.dockerfile !== undefined,
	);

	// oxlint-disable-next-line no-await-in-loop -- image builds are intentionally sequential for stable task output and shared image tags
	for (const imageTarget of dockerImageTargets) {
		// oxlint-disable-next-line no-await-in-loop -- each image tag is resolved in lockstep with its matching build task
		const imageTag = await resolveOciImageTag(imageTarget.buildConfigPath);
		if (
			imageTarget.name === 'gateway' &&
			options.systemConfig.zones.some((zone) => zone.gateway.type === 'openclaw')
		) {
			// Resolve the scaffold root via config/system.json instead of assuming a fixed
			// images/gateway/Dockerfile depth.
			// oxlint-disable-next-line no-await-in-loop -- root discovery belongs to the matching build target
			const projectRootDirectory = await resolveProjectRoot(imageTarget.dockerfile);
			// oxlint-disable-next-line no-await-in-loop -- bundle sync must complete before the matching docker build starts
			await runTaskStep('OpenClaw plugin bundle', async () => {
				await syncBundledOpenClawPlugin(projectRootDirectory);
			});
		}
		// oxlint-disable-next-line no-await-in-loop -- docker builds intentionally run one at a time to keep task output readable
		await runTaskStep(`Docker: ${imageTarget.name} (${imageTag})`, async () => {
			await buildDockerImage({
				dockerfilePath: imageTarget.dockerfile,
				imageTag,
			});
		});
	}
	const dockerBackedTargets = new Set(dockerImageTargets.map((imageTarget) => imageTarget.name));

	for (const imageTarget of imageTargets) {
		const cacheDirectory = path.join(options.systemConfig.cacheDir, 'images', imageTarget.name);
		const shouldResetGondolinCache =
			options.forceRebuild === true || dockerBackedTargets.has(imageTarget.name);
		// oxlint-disable-next-line no-await-in-loop -- gondolin cache rebuilds are intentionally sequenced per image target
		await runTaskStep(`Gondolin: ${imageTarget.name}`, async () => {
			await buildGondolinImage({
				buildConfigPath: imageTarget.buildConfigPath,
				cacheDir: cacheDirectory,
				...(shouldResetGondolinCache ? { fullReset: true } : {}),
			});
		});
	}
}
