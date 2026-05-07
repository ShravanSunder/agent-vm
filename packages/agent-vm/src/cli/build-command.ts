import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildImageResult } from '@agent-vm/gondolin-adapter';
import { resolveGondolinMinimumZigVersion } from '@agent-vm/gondolin-adapter';
import { execa } from 'execa';
import { z } from 'zod';

import { buildDockerImage as buildDockerImageDefault } from '../build/docker-image-builder.js';
import { buildGondolinImage as buildGondolinImageDefault } from '../build/gondolin-image-builder.js';
import {
	MANAGED_OPENCLAW_VERSION,
	generateManagedDockerfile as generateManagedDockerfileDefault,
	resolveManagedImageRelease as resolveManagedImageReleaseDefault,
	type ManagedImageRelease,
	type ManagedImageSource,
} from '../build/managed-image-dockerfile.js';
import {
	deleteStaleImageDirectories as deleteStaleImageDirectoriesDefault,
	findPrunableImageDirectories as findPrunableImageDirectoriesDefault,
	type CurrentImageFingerprints,
	type StaleImageEntry,
} from '../build/stale-image-cleaner.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	buildZigInstallHint,
	buildZigUpgradeHint,
	isVersionAtLeast,
} from '../operations/doctor.js';
import type { RunTaskContext, RunTaskFn, TaskOutput } from '../shared/run-task.js';
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
	readonly deleteStaleImageDirectories?: (entries: readonly StaleImageEntry[]) => Promise<void>;
	readonly findPrunableImageDirectories?: (options: {
		readonly cacheDir: string;
		readonly currentFingerprints: CurrentImageFingerprints;
		readonly retainStaleGenerationsPerProfile: number;
	}) => Promise<readonly StaleImageEntry[]>;
	readonly resolveOciImageTag?: (buildConfigPath: string) => Promise<string>;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
	/** Override the task runner for testing or custom CLI progress. */
	readonly runTask?: RunTaskFn;
	readonly resolveProjectRootFromDockerfile?: (dockerfilePath: string) => Promise<string>;
	readonly generateManagedDockerfile?: (options: {
		readonly base: ManagedImageSource['base'];
		readonly imageTargetFamily: 'gateway' | 'toolVm';
		readonly imageTargetName: string;
		readonly outputDirectory: string;
		readonly overlayPath?: string | undefined;
		readonly managedImageRelease: ManagedImageRelease;
		readonly requiredOpenClawPackages?: readonly string[];
	}) => Promise<string>;
	readonly resolveManagedImageRelease?: () => Promise<ManagedImageRelease>;
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

const RETAIN_STALE_IMAGE_GENERATIONS_PER_PROFILE = 2;
const gatewayRuntimeRecordFileName = 'gateway-runtime.json';

const openClawManagedPackageConfigSchema = z
	.object({
		channels: z
			.object({
				discord: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

interface OpenClawManagedPackageRule {
	readonly isEnabled: (config: z.infer<typeof openClawManagedPackageConfigSchema>) => boolean;
	readonly packageName: string;
}

const openClawManagedPackageRules = [
	{
		packageName: '@openclaw/discord',
		isEnabled: (config) => config.channels?.discord?.enabled === true,
	},
] as const satisfies readonly OpenClawManagedPackageRule[];

interface ImageTarget {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
	readonly systemCacheIdentifierPath: string;
	readonly dockerfile: string | undefined;
	readonly family: 'gateway' | 'toolVm';
	readonly gatewayType?: 'worker' | 'openclaw';
	readonly name: string;
	readonly source: ManagedImageSource | undefined;
}

function imageTargetKey(imageTarget: Pick<ImageTarget, 'family' | 'name'>): string {
	return `${imageTarget.family}/${imageTarget.name}`;
}

function createEmptyCurrentImageFingerprints(): CurrentImageFingerprints {
	return {
		gateways: {},
		toolVms: {},
	};
}

function setCurrentImageFingerprint(
	currentFingerprints: CurrentImageFingerprints,
	imageTarget: Pick<ImageTarget, 'family' | 'name'>,
	fingerprint: string,
): void {
	if (imageTarget.family === 'gateway') {
		currentFingerprints.gateways[imageTarget.name] = fingerprint;
		return;
	}
	currentFingerprints.toolVms[imageTarget.name] = fingerprint;
}

async function findZoneIdsWithGatewayRuntimeRecords(
	systemConfig: LoadedSystemConfig,
): Promise<readonly string[]> {
	const zoneIds: string[] = [];
	for (const zone of systemConfig.zones) {
		const runtimeRecordPath = path.join(zone.gateway.stateDir, gatewayRuntimeRecordFileName);
		let runtimeRecordExists = false;
		try {
			// oxlint-disable-next-line no-await-in-loop -- state dirs are zone-local and errors should point at one zone
			await fs.access(runtimeRecordPath);
			runtimeRecordExists = true;
		} catch (error) {
			if (
				typeof error !== 'object' ||
				error === null ||
				!('code' in error) ||
				error.code !== 'ENOENT'
			) {
				throw error;
			}
		}
		if (runtimeRecordExists) {
			zoneIds.push(zone.id);
		}
	}
	return zoneIds;
}

function startElapsedStatusHeartbeat(
	taskContext: RunTaskContext | undefined,
	baseStatus: string,
): () => void {
	taskContext?.setStatus(baseStatus);
	if (taskContext?.interactive !== true) {
		return () => {};
	}

	const startedAtMs = Date.now();
	const heartbeatInterval = setInterval(() => {
		const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAtMs) / 1000));
		taskContext.setStatus(`${baseStatus} · ${elapsedSeconds}s elapsed`);
	}, 8_000);

	return () => {
		clearInterval(heartbeatInterval);
	};
}

async function resolveOciImageTagFromConfig(buildConfigPath: string): Promise<string> {
	const rawConfig = await loadJsonConfigFile(buildConfigPath);
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
	imageTargets: readonly ImageTarget[],
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
			try {
				// oxlint-disable-next-line no-await-in-loop -- upward root discovery is intentionally sequential
				await fs.access(path.join(searchDirectory, 'config', 'system.jsonc'));
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
}

async function resolveRequiredOpenClawPackagesForTarget(
	systemConfig: LoadedSystemConfig,
	imageTarget: ImageTarget,
): Promise<readonly string[]> {
	if (
		imageTarget.family !== 'gateway' ||
		imageTarget.gatewayType !== 'openclaw' ||
		imageTarget.source?.base !== 'openclaw-gateway'
	) {
		return [];
	}
	const requiredPackageSpecs = new Set<string>();
	for (const zone of systemConfig.zones) {
		if (zone.gateway.type !== 'openclaw' || zone.gateway.imageProfile !== imageTarget.name) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- zone config reads are tiny and error messages stay profile-local
		const rawOpenClawConfig = await loadJsonConfigFile(zone.gateway.config);
		const openClawConfig = openClawManagedPackageConfigSchema.parse(rawOpenClawConfig);
		for (const packageRule of openClawManagedPackageRules) {
			if (packageRule.isEnabled(openClawConfig)) {
				requiredPackageSpecs.add(`${packageRule.packageName}@${MANAGED_OPENCLAW_VERSION}`);
			}
		}
	}
	return [...requiredPackageSpecs].toSorted();
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
	const deleteStaleImageDirectories =
		dependencies.deleteStaleImageDirectories ?? deleteStaleImageDirectoriesDefault;
	const findPrunableImageDirectories =
		dependencies.findPrunableImageDirectories ?? findPrunableImageDirectoriesDefault;
	const resolveOciImageTag = dependencies.resolveOciImageTag ?? resolveOciImageTagFromConfig;
	const resolveRequiredZigVersion =
		dependencies.resolveRequiredZigVersion ?? resolveGondolinMinimumZigVersion;
	const resolveZigVersion = dependencies.resolveZigVersion ?? resolveHostZigVersion;
	const runTaskStep = dependencies.runTask ?? defaultRunTask;
	const resolveProjectRoot =
		dependencies.resolveProjectRootFromDockerfile ?? resolveProjectRootFromDockerfile;
	const generateManagedDockerfile =
		dependencies.generateManagedDockerfile ?? generateManagedDockerfileDefault;
	const resolveManagedImageRelease =
		dependencies.resolveManagedImageRelease ?? resolveManagedImageReleaseDefault;
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
		source: profile.source,
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
		source: profile.source,
	}));
	const imageTargets: readonly ImageTarget[] = [...gatewayImageTargets, ...toolVmImageTargets];
	const dockerImageTargets = imageTargets.filter(
		(imageTarget) => imageTarget.dockerfile !== undefined || imageTarget.source !== undefined,
	);
	const dockerImageTagByProfile = await assertUniqueDockerImageTags(
		dockerImageTargets,
		resolveOciImageTag,
	);
	const managedImageRelease = dockerImageTargets.some(
		(imageTarget) => imageTarget.source !== undefined,
	)
		? await resolveManagedImageRelease()
		: undefined;

	// oxlint-disable-next-line no-await-in-loop -- image builds are intentionally sequential for stable task output and shared image tags
	for (const imageTarget of dockerImageTargets) {
		const imageTag = dockerImageTagByProfile.get(imageTarget.name);
		if (!imageTag) {
			throw new Error(`Missing resolved Docker image tag for image profile '${imageTarget.name}'.`);
		}
		let dockerfilePath = imageTarget.dockerfile;
		if (imageTarget.source) {
			if (!managedImageRelease) {
				throw new Error('Missing managed image release for managed image build.');
			}
			// oxlint-disable-next-line no-await-in-loop -- package detection is profile-local and low-volume
			const requiredOpenClawPackages = await resolveRequiredOpenClawPackagesForTarget(
				options.systemConfig,
				imageTarget,
			);
			// oxlint-disable-next-line no-await-in-loop -- each generated Docker context belongs to one image target
			dockerfilePath = await generateManagedDockerfile({
				base: imageTarget.source.base,
				imageTargetFamily: imageTarget.family,
				imageTargetName: imageTarget.name,
				outputDirectory: path.join(
					options.systemConfig.cacheDir,
					'generated-dockerfiles',
					imageTarget.family,
					imageTarget.name,
				),
				...(imageTarget.source.overlay ? { overlayPath: imageTarget.source.overlay } : {}),
				managedImageRelease,
				requiredOpenClawPackages,
			});
		}
		if (!dockerfilePath) {
			throw new Error(`Missing Dockerfile path for image profile '${imageTarget.name}'.`);
		}
		if (
			imageTarget.family === 'gateway' &&
			imageTarget.gatewayType === 'openclaw' &&
			!imageTarget.source
		) {
			// Resolve the scaffold root via config/system.json instead of assuming a fixed
			// vm-images/gateways/openclaw/Dockerfile depth.
			// oxlint-disable-next-line no-await-in-loop -- root discovery belongs to the matching build target
			const projectRootDirectory = await resolveProjectRoot(dockerfilePath);
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
					dockerfilePath,
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
	const currentFingerprints = createEmptyCurrentImageFingerprints();

	for (const imageTarget of imageTargets) {
		const shouldResetGondolinCache =
			options.forceRebuild === true || dockerBackedTargets.has(imageTargetKey(imageTarget));
		// oxlint-disable-next-line no-await-in-loop -- gondolin cache rebuilds are intentionally sequenced per image target
		await runTaskStep(
			`Gondolin: ${imageTarget.family}/${imageTarget.name}`,
			async (taskContext) => {
				const stopHeartbeat = startElapsedStatusHeartbeat(
					taskContext,
					shouldResetGondolinCache ? 'building vm assets' : 'checking vm assets',
				);
				let result: BuildImageResult;
				try {
					result = await buildGondolinImage({
						buildConfigPath: imageTarget.buildConfigPath,
						systemCacheIdentifierPath: imageTarget.systemCacheIdentifierPath,
						cacheDir: imageTarget.cacheDirectory,
						...(shouldResetGondolinCache ? { fullReset: true } : {}),
						...(taskContext?.interactive === true && taskContext.streamPreview
							? { streamPreview: taskContext.streamPreview }
							: {}),
					});
				} finally {
					stopHeartbeat();
				}
				setCurrentImageFingerprint(currentFingerprints, imageTarget, result.fingerprint);
				taskContext?.setStatus(result.built ? 'vm assets ready' : 'vm assets cache hit');
			},
		);
	}

	await runTaskStep('Cache auto-prune', async (taskContext) => {
		taskContext?.setStatus('checking old image generations');
		try {
			const activeGatewayRuntimeZoneIds = await findZoneIdsWithGatewayRuntimeRecords(
				options.systemConfig,
			);
			if (activeGatewayRuntimeZoneIds.length > 0) {
				taskContext?.setOutput({
					message: `Image cache auto-prune skipped because gateway runtime records exist for zone(s): ${activeGatewayRuntimeZoneIds.join(', ')}. Stop the controller before pruning old image generations.`,
				});
				taskContext?.setStatus('image cache auto-prune skipped');
				return;
			}

			const prunableEntries = await findPrunableImageDirectories({
				cacheDir: options.systemConfig.cacheDir,
				currentFingerprints,
				retainStaleGenerationsPerProfile: RETAIN_STALE_IMAGE_GENERATIONS_PER_PROFILE,
			});

			if (prunableEntries.length === 0) {
				taskContext?.setStatus('no old image generations found');
				return;
			}

			await deleteStaleImageDirectories(prunableEntries);
			taskContext?.setStatus(
				`deleted ${prunableEntries.length} old image generation${
					prunableEntries.length === 1 ? '' : 's'
				}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			taskContext?.setOutput({
				message: `Image cache auto-prune failed after build succeeded: ${message}`,
			});
			taskContext?.setStatus('image cache auto-prune failed');
		}
	});
}
