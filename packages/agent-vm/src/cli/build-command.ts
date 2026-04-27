import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildImageResult } from '@agent-vm/gondolin-adapter';
import { resolveGondolinMinimumZigVersion } from '@agent-vm/gondolin-adapter';
import { execa } from 'execa';
import { z } from 'zod';

import { buildDockerImage as buildDockerImageDefault } from '../build/docker-image-builder.js';
import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	buildZigInstallHint,
	buildZigUpgradeHint,
	isVersionAtLeast,
} from '../operations/doctor.js';
import type { RunTaskFn, TaskOutput } from '../shared/run-task.js';
import { formatZodError } from './format-zod-error.js';
import { syncBundledOpenClawPluginBundle } from './openclaw-plugin-bundle.js';

export interface BuildCommandDependencies {
	readonly buildDockerImage?: (options: {
		readonly dockerfilePath: string;
		readonly imageTag: string;
		readonly streamPreview?: TaskOutput;
	}) => Promise<void>;
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly systemCacheIdentifierPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
		readonly streamPreview?: TaskOutput;
	}) => Promise<BuildImageResult>;
	readonly resolveOciImageTag?: (buildConfigPath: string) => Promise<string>;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
	/** Override the task runner for testing or custom CLI progress. */
	readonly runTask?: RunTaskFn;
	readonly resolveProjectRootFromDockerfile?: (dockerfilePath: string) => Promise<string>;
	readonly syncBundledOpenClawPlugin?: (
		targetDir: string,
		profileName: string,
	) => Promise<'created' | 'skipped'>;
}

const ociImageTagSchema = z.object({
	oci: z.object({
		image: z.string().min(1),
	}),
});

interface ImageTarget {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
	readonly systemCacheIdentifierPath: string;
	readonly dockerfile: string | undefined;
	readonly family: 'gateway' | 'toolVm';
	readonly gatewayType?: 'worker' | 'openclaw';
	readonly name: string;
}

function imageTargetKey(imageTarget: Pick<ImageTarget, 'family' | 'name'>): string {
	return `${imageTarget.family}/${imageTarget.name}`;
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

async function resolveHostZigVersion(): Promise<string | undefined> {
	try {
		const result = await execa('zig', ['version']);
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

async function assertZigBuildPrerequisite(
	resolveRequiredZigVersion: () => Promise<string>,
	resolveZigVersion: () => Promise<string | undefined>,
): Promise<void> {
	const requiredZigVersion = await resolveRequiredZigVersion();
	const zigVersion = await resolveZigVersion();
	if (!zigVersion) {
		throw new Error(buildZigInstallHint(requiredZigVersion));
	}
	if (!isVersionAtLeast(zigVersion, requiredZigVersion)) {
		throw new Error(`${buildZigUpgradeHint(requiredZigVersion)} Current version: ${zigVersion}.`);
	}
}

async function assertUniqueDockerImageTags(
	imageTargets: readonly (ImageTarget & { readonly dockerfile: string })[],
	resolveOciImageTag: (buildConfigPath: string) => Promise<string>,
): Promise<Map<string, string>> {
	const profileByTag = new Map<string, string>();
	const tagByProfile = new Map<string, string>();

	for (const imageTarget of imageTargets) {
		// oxlint-disable-next-line no-await-in-loop -- collision errors are clearer in stable target order
		const imageTag = await resolveOciImageTag(imageTarget.buildConfigPath);
		const existingProfile = profileByTag.get(imageTag);
		if (existingProfile) {
			throw new Error(
				`Docker image tag '${imageTag}' is used by both image profiles '${existingProfile}' and '${imageTarget.name}'. Give each Docker-backed image profile a unique oci.image tag.`,
			);
		}
		profileByTag.set(imageTag, imageTarget.name);
		tagByProfile.set(imageTarget.name, imageTag);
	}

	return tagByProfile;
}

const defaultRunTask: RunTaskFn = async (title, fn): Promise<void> => {
	process.stderr.write(`  ${title}...\n`);
	await fn({
		interactive: false,
		setOutput: () => {},
		setStatus: () => {},
	});
	process.stderr.write(`  ${title} done\n`);
};

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
				// standard vm-images/gateways/openclaw/Dockerfile shape but do not materialize config/system.json.
				return path.resolve(dockerfilePath, '..', '..', '..');
			}
			searchDirectory = parentDirectory;
		}
	}
}

export async function runBuildCommand(
	options: {
		readonly forceRebuild?: boolean;
		readonly systemConfig: LoadedSystemConfig;
	},
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	const buildDockerImage = dependencies.buildDockerImage ?? buildDockerImageDefault;
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const resolveOciImageTag = dependencies.resolveOciImageTag ?? resolveOciImageTagFromConfig;
	const resolveRequiredZigVersion =
		dependencies.resolveRequiredZigVersion ?? resolveGondolinMinimumZigVersion;
	const resolveZigVersion = dependencies.resolveZigVersion ?? resolveHostZigVersion;
	const runTaskStep = dependencies.runTask ?? defaultRunTask;
	const resolveProjectRoot =
		dependencies.resolveProjectRootFromDockerfile ?? resolveProjectRootFromDockerfile;
	const syncBundledOpenClawPlugin =
		dependencies.syncBundledOpenClawPlugin ?? syncBundledOpenClawPluginBundle;
	const systemCacheIdentifierPath = options.systemConfig.systemCacheIdentifierPath;

	await assertZigBuildPrerequisite(resolveRequiredZigVersion, resolveZigVersion);

	const gatewayImageTargets: readonly ImageTarget[] = Object.entries(
		options.systemConfig.imageProfiles.gateways,
	).map(([profileName, profile]) => ({
		buildConfigPath: profile.buildConfig,
		cacheDirectory: path.join(options.systemConfig.cacheDir, 'gateway-images', profileName),
		systemCacheIdentifierPath,
		dockerfile: profile.dockerfile,
		family: 'gateway' as const,
		gatewayType: profile.type,
		name: profileName,
	}));
	const toolVmImageTargets: readonly ImageTarget[] = Object.entries(
		options.systemConfig.imageProfiles.toolVms,
	).map(([profileName, profile]) => ({
		buildConfigPath: profile.buildConfig,
		cacheDirectory: path.join(options.systemConfig.cacheDir, 'tool-vm-images', profileName),
		systemCacheIdentifierPath,
		dockerfile: profile.dockerfile,
		family: 'toolVm' as const,
		name: profileName,
	}));
	const imageTargets: readonly ImageTarget[] = [...gatewayImageTargets, ...toolVmImageTargets];
	const dockerImageTargets = imageTargets.filter(
		(imageTarget): imageTarget is ImageTarget & { readonly dockerfile: string } =>
			imageTarget.dockerfile !== undefined,
	);
	const dockerImageTagByProfile = await assertUniqueDockerImageTags(
		dockerImageTargets,
		resolveOciImageTag,
	);

	// oxlint-disable-next-line no-await-in-loop -- image builds are intentionally sequential for stable task output and shared image tags
	for (const imageTarget of dockerImageTargets) {
		const imageTag = dockerImageTagByProfile.get(imageTarget.name);
		if (!imageTag) {
			throw new Error(`Missing resolved Docker image tag for image profile '${imageTarget.name}'.`);
		}
		if (imageTarget.family === 'gateway' && imageTarget.gatewayType === 'openclaw') {
			// Resolve the scaffold root via config/system.json instead of assuming a fixed
			// vm-images/gateways/openclaw/Dockerfile depth.
			// oxlint-disable-next-line no-await-in-loop -- root discovery belongs to the matching build target
			const projectRootDirectory = await resolveProjectRoot(imageTarget.dockerfile);
			// oxlint-disable-next-line no-await-in-loop -- bundle sync must complete before the matching docker build starts
			await runTaskStep('OpenClaw plugin bundle', async () => {
				await syncBundledOpenClawPlugin(projectRootDirectory, imageTarget.name);
			});
		}
		// oxlint-disable-next-line no-await-in-loop -- docker builds intentionally run one at a time to keep task output readable
		await runTaskStep(
			`Docker: ${imageTarget.family}/${imageTarget.name} (${imageTag})`,
			async (taskContext) => {
				taskContext?.setStatus('docker build');
				await buildDockerImage({
					dockerfilePath: imageTarget.dockerfile,
					imageTag,
					...(taskContext?.interactive === true && taskContext.streamPreview
						? { streamPreview: taskContext.streamPreview }
						: {}),
				});
				taskContext?.setStatus('docker image ready');
			},
		);
	}
	const dockerBackedTargets = new Set(
		dockerImageTargets.map((imageTarget) => imageTargetKey(imageTarget)),
	);

	for (const imageTarget of imageTargets) {
		const shouldResetGondolinCache =
			options.forceRebuild === true || dockerBackedTargets.has(imageTargetKey(imageTarget));
		// oxlint-disable-next-line no-await-in-loop -- gondolin cache rebuilds are intentionally sequenced per image target
		await runTaskStep(
			`Gondolin: ${imageTarget.family}/${imageTarget.name}`,
			async (taskContext) => {
				taskContext?.setStatus('vm assets');
				await buildGondolinImage({
					buildConfigPath: imageTarget.buildConfigPath,
					systemCacheIdentifierPath: imageTarget.systemCacheIdentifierPath,
					cacheDir: imageTarget.cacheDirectory,
					...(taskContext?.interactive === true && taskContext.streamPreview
						? { streamPreview: taskContext.streamPreview }
						: {}),
					...(shouldResetGondolinCache ? { fullReset: true } : {}),
				});
				taskContext?.setStatus('vm assets ready');
			},
		);
	}
}
