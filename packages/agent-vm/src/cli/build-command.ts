import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildImageAssetFileNames,
	hasBuiltImageAssets,
	type BuildImageResult,
} from '@agent-vm/gondolin-adapter';
import { z } from 'zod';

import {
	buildDockerImage as buildDockerImageDefault,
	resolveDockerRootfsIdentity as resolveDockerRootfsIdentityDefault,
	type DockerRootfsIdentity,
} from '../build/docker-image-builder.js';
import {
	buildGondolinImage as buildGondolinImageDefault,
	computeFingerprintFromConfigPath,
} from '../build/gondolin-image-builder.js';
import {
	generateManagedDockerfile as generateManagedDockerfileDefault,
	resolveManagedImageRelease as resolveManagedImageReleaseDefault,
	type GenerateManagedDockerfileResult,
	type ManagedDockerfilePackagePlanEntry,
	type ManagedDockerfilePlan,
	type ManagedImageRelease,
	type ManagedImageSource,
} from '../build/managed-image-dockerfile.js';
import { writePreparedGondolinImage } from '../build/prepared-gondolin-image-cache.js';
import {
	deleteStaleImageDirectories as deleteStaleImageDirectoriesDefault,
	findPrunableImageDirectories as findPrunableImageDirectoriesDefault,
	type CurrentImageFingerprints,
	type StaleImageEntry,
} from '../build/stale-image-cleaner.js';
import {
	assertGondolinZigCompatibility,
	resolveGondolinCompatibleZigVersion,
	resolveHostZigVersion,
} from '../build/zig-compatibility.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import type {
	RunTaskContext,
	RunTaskFn,
	RunTaskGroupFn,
	RunTaskGroupTask,
	TaskOutput,
} from '../shared/run-task.js';
import { formatZodError } from './format-zod-error.js';
import { syncBundledOpenClawPluginBundle } from './openclaw-plugin-bundle.js';

export interface BuildCommandDependencies {
	readonly buildDockerImage?: (options: {
		readonly dockerfilePath: string;
		readonly imageTag: string;
		readonly quiet?: boolean;
		readonly streamPreview?: TaskOutput;
	}) => Promise<void>;
	readonly buildGondolinImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fingerprintInput?: unknown;
		readonly fullReset?: boolean;
		readonly streamPreview?: TaskOutput;
	}) => Promise<BuildImageResult>;
	readonly computeGondolinFingerprint?: (options: {
		readonly buildConfigPath: string;
		readonly fingerprintInput?: unknown;
	}) => Promise<string>;
	readonly deleteStaleImageDirectories?: (entries: readonly StaleImageEntry[]) => Promise<void>;
	readonly findPrunableImageDirectories?: (options: {
		readonly cacheDir: string;
		readonly currentFingerprints: CurrentImageFingerprints;
		readonly retainStaleGenerationsPerProfile: number;
	}) => Promise<readonly StaleImageEntry[]>;
	readonly resolveOciImageTag?: (buildConfigPath: string) => Promise<string>;
	readonly resolveDockerRootfsIdentity?: (
		imageTag: string,
	) => Promise<DockerRootfsIdentity | undefined>;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
	/** Override the task runner for testing or custom CLI progress. */
	readonly runTask?: RunTaskFn;
	readonly runTaskGroup?: RunTaskGroupFn;
	readonly resolveProjectRootFromDockerfile?: (dockerfilePath: string) => Promise<string>;
	readonly generateManagedDockerfile?: (options: {
		readonly base: ManagedImageSource['base'];
		readonly imageTargetFamily: 'gateway' | 'toolVm';
		readonly imageTargetName: string;
		readonly outputDirectory: string;
		readonly overlayPath?: string | undefined;
		readonly managedImageRelease: ManagedImageRelease;
		readonly requiredOpenClawPackageNames?: readonly string[];
	}) => Promise<GenerateManagedDockerfileResult>;
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
const DOCKER_BUILD_CONCURRENCY = 2;
const GONDOLIN_BUILD_CONCURRENCY = 2;
const BUILD_DETAIL_MAX_LENGTH = 180;
const GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV = 'GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE';
const TASK_OUTPUT_BUFFER_MAX_LENGTH = 4_096;
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
	readonly dockerfile: string | undefined;
	readonly family: 'gateway' | 'toolVm';
	readonly gatewayType?: 'worker' | 'openclaw';
	readonly name: string;
	readonly source: ManagedImageSource | undefined;
}

interface BuiltImageCacheEntry {
	readonly imageTarget: ImageTarget;
	readonly result: BuildImageResult;
}

interface DockerBackedFingerprintInput {
	readonly dockerRootfsIdentity: DockerRootfsIdentity;
	readonly schemaVersion: 1;
}

interface DockerBuildPlan {
	readonly dockerfilePath: string;
	readonly imageTag: string;
	readonly imageTarget: ImageTarget;
	readonly managedDockerfilePlan?: ManagedDockerfilePlan;
}

interface BuiltImagePlanResult {
	readonly imageTarget: ImageTarget;
	readonly targetPlan: GondolinTargetPlan;
	readonly result: BuildImageResult;
}

interface GondolinTargetPlan {
	readonly dedupeKey: string;
	readonly fingerprint: string;
	readonly imageTarget: ImageTarget;
	readonly fingerprintInput?: unknown;
	readonly key: string;
	sharedDedupeKey: boolean;
	shouldResetGondolinCache: boolean;
}

const imageTargetKeySeparator = '\0';

function imageTargetKey(imageTarget: Pick<ImageTarget, 'family' | 'name'>): string {
	return `${imageTarget.family}/${imageTarget.name}`;
}

function imageTargetDedupeKey(options: {
	readonly buildConfigPath: string;
	readonly fingerprint: string;
}): string {
	return `${path.resolve(options.buildConfigPath)}${imageTargetKeySeparator}${options.fingerprint}`;
}

function imageTargetFingerprintInputKey(options: {
	readonly buildConfigPath: string;
	readonly fingerprintInput?: unknown;
}): string {
	return `${path.resolve(options.buildConfigPath)}${imageTargetKeySeparator}${JSON.stringify(options.fingerprintInput ?? null)}`;
}

async function runWithConcurrency<TItem>(
	items: readonly TItem[],
	concurrency: number,
	fn: (item: TItem) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const workerCount = Math.min(concurrency, items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		for (;;) {
			const item = items[nextIndex];
			nextIndex += 1;
			if (item === undefined) {
				return;
			}
			// oxlint-disable-next-line no-await-in-loop -- each worker intentionally processes its own queue slot serially while workers run in parallel
			await fn(item);
		}
	});
	await Promise.all(workers);
}

function createRunTaskGroupFallback(runTaskStep: RunTaskFn): RunTaskGroupFn {
	return async (tasks, options) => {
		await runWithConcurrency(tasks, options.concurrency, async (task) => {
			await runTaskStep(task.title, task.fn);
		});
	};
}

function firstGondolinTargetPlan(targetPlans: readonly GondolinTargetPlan[]): GondolinTargetPlan {
	const [targetPlan] = targetPlans;
	if (!targetPlan) {
		throw new Error('Expected at least one Gondolin target plan.');
	}
	return targetPlan;
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

async function linkOrCopyImageAsset(sourcePath: string, targetPath: string): Promise<void> {
	try {
		await fs.link(sourcePath, targetPath);
	} catch (error) {
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(error.code === 'EXDEV' ||
				error.code === 'EPERM' ||
				error.code === 'EOPNOTSUPP' ||
				error.code === 'ENOTSUP' ||
				error.code === 'EACCES')
		) {
			try {
				await fs.copyFile(sourcePath, targetPath);
				return;
			} catch (copyError) {
				throw new Error(
					`Failed to copy Gondolin image asset from '${sourcePath}' to '${targetPath}'.`,
					{ cause: copyError },
				);
			}
		}
		throw new Error(
			`Failed to link Gondolin image asset from '${sourcePath}' to '${targetPath}'.`,
			{ cause: error },
		);
	}
}

async function materializeGondolinImageAlias(options: {
	readonly fingerprint: string;
	readonly fullReset: boolean;
	readonly sourceImagePath: string;
	readonly targetCacheDirectory: string;
}): Promise<string> {
	const targetImagePath = path.join(options.targetCacheDirectory, options.fingerprint);
	if (path.resolve(options.sourceImagePath) === path.resolve(targetImagePath)) {
		return targetImagePath;
	}
	if (!options.fullReset && (await hasBuiltImageAssets(targetImagePath))) {
		return targetImagePath;
	}
	await fs.rm(targetImagePath, { recursive: true, force: true });
	await fs.mkdir(targetImagePath, { recursive: true });
	for (const fileName of buildImageAssetFileNames) {
		// oxlint-disable-next-line no-await-in-loop -- preserve deterministic asset copy/link ordering
		await linkOrCopyImageAsset(
			path.join(options.sourceImagePath, fileName),
			path.join(targetImagePath, fileName),
		);
	}
	return targetImagePath;
}

async function materializePreparedTargetImage(options: {
	readonly fingerprint: string;
	readonly fullReset: boolean;
	readonly sourceImagePath: string;
	readonly targetCacheDirectory: string;
}): Promise<string> {
	const targetImagePath = path.join(options.targetCacheDirectory, options.fingerprint);
	if (path.resolve(options.sourceImagePath) === path.resolve(targetImagePath)) {
		return targetImagePath;
	}
	if (!(await hasBuiltImageAssets(options.sourceImagePath))) {
		return options.sourceImagePath;
	}
	return await materializeGondolinImageAlias(options);
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

interface ElapsedStatusController {
	readonly setBaseStatus: (status: string) => void;
	readonly stop: () => void;
}

function startElapsedStatusController(
	taskContext: RunTaskContext | undefined,
	initialStatus: string,
): ElapsedStatusController {
	let currentStatus = initialStatus;
	const renderStatus = (): void => {
		if (taskContext?.interactive === true) {
			const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAtMs) / 1000));
			taskContext.setStatus(`${currentStatus} · ${elapsedSeconds}s elapsed`);
			return;
		}
		taskContext?.setStatus(currentStatus);
	};

	const startedAtMs = Date.now();
	taskContext?.setStatus(currentStatus);
	const heartbeatInterval =
		taskContext?.interactive === true ? setInterval(renderStatus, 8_000) : undefined;

	return {
		setBaseStatus: (status) => {
			currentStatus = status;
			renderStatus();
		},
		stop: () => {
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
			}
		},
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

async function assertZigBuildPrerequisite(
	resolveRequiredZigVersion: () => Promise<string>,
	resolveZigVersion: () => Promise<string | undefined>,
): Promise<void> {
	const requiredZigVersion = await resolveRequiredZigVersion();
	const zigVersion = await resolveZigVersion();
	assertGondolinZigCompatibility({
		requiredVersion: requiredZigVersion,
		...(zigVersion ? { installedVersion: zigVersion } : {}),
	});
}

function isTruthyEnvironmentFlag(value: string | undefined): boolean {
	const normalizedValue = value?.trim().toLowerCase();
	return (
		normalizedValue === '1' ||
		normalizedValue === 'true' ||
		normalizedValue === 'yes' ||
		normalizedValue === 'on'
	);
}

function shouldAssertZigBuildPrerequisite(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvironmentFlag(env[GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV]);
}

async function assertUniqueDockerImageTags(
	imageTargets: readonly ImageTarget[],
	resolveOciImageTag: (buildConfigPath: string) => Promise<string>,
): Promise<Map<string, string>> {
	const profileByTag = new Map<string, string>();
	const tagByTargetKey = new Map<string, string>();

	for (const imageTarget of imageTargets) {
		// oxlint-disable-next-line no-await-in-loop -- collision errors are clearer in stable target order
		const imageTag = await resolveOciImageTag(imageTarget.buildConfigPath);
		const existingProfile = profileByTag.get(imageTag);
		const key = imageTargetKey(imageTarget);
		if (existingProfile) {
			throw new Error(
				`Docker image tag '${imageTag}' is used by both image profiles '${existingProfile}' and '${key}'. Give each Docker-backed image profile a unique oci.image tag.`,
			);
		}
		profileByTag.set(imageTag, key);
		tagByTargetKey.set(key, imageTag);
	}

	return tagByTargetKey;
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
	const requiredPackageNames = new Set<string>();
	for (const zone of systemConfig.zones) {
		if (zone.gateway.type !== 'openclaw' || zone.gateway.imageProfile !== imageTarget.name) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- zone config reads are tiny and error messages stay profile-local
		const rawOpenClawConfig = await loadJsonConfigFile(zone.gateway.config);
		const openClawConfig = openClawManagedPackageConfigSchema.parse(rawOpenClawConfig);
		for (const packageRule of openClawManagedPackageRules) {
			if (packageRule.isEnabled(openClawConfig)) {
				requiredPackageNames.add(packageRule.packageName);
			}
		}
	}
	return [...requiredPackageNames].toSorted();
}

function shortenBuildDetail(detail: string): string {
	if (detail.length <= BUILD_DETAIL_MAX_LENGTH) {
		return detail;
	}
	const prefixLength = Math.max(20, Math.floor((BUILD_DETAIL_MAX_LENGTH - 5) * 0.55));
	const suffixLength = BUILD_DETAIL_MAX_LENGTH - prefixLength - 5;
	return `${detail.slice(0, prefixLength)} ... ${detail.slice(-suffixLength)}`;
}

function packageNameFromSpec(packageSpec: string): string {
	const versionSeparatorIndex = packageSpec.lastIndexOf('@');
	const unversionedSpec =
		versionSeparatorIndex > 0 ? packageSpec.slice(0, versionSeparatorIndex) : packageSpec;
	return unversionedSpec.replace(/^@openclaw\//, '').replace(/^@agent-vm\//, '');
}

function packageVersionFromSpec(packageSpec: string): string | undefined {
	const versionSeparatorIndex = packageSpec.lastIndexOf('@');
	if (versionSeparatorIndex <= 0) {
		return undefined;
	}
	return packageSpec.slice(versionSeparatorIndex + 1);
}

function formatAgentVmPackageStatus(
	packages: readonly ManagedDockerfilePackagePlanEntry[],
): string | undefined {
	if (packages.length === 0) {
		return undefined;
	}
	const versions = [
		...new Set(
			packages
				.map((packageEntry) => packageVersionFromSpec(packageEntry.spec))
				.filter((version): version is string => version !== undefined),
		),
	];
	return versions.length === 1 ? `agent-vm ${versions[0]}` : 'agent-vm packages';
}

function formatManagedPackagePlanEntry(packageEntry: ManagedDockerfilePackagePlanEntry): string {
	return `${packageNameFromSpec(packageEntry.spec)}@${packageVersionFromSpec(packageEntry.spec) ?? 'unversioned'}[${packageEntry.source}]`;
}

function formatDockerBaseDetail(options: {
	readonly dockerfilePath: string;
	readonly imageTarget: ImageTarget;
	readonly managedDockerfilePlan?: ManagedDockerfilePlan;
}): string {
	const details: string[] = [];
	const plan = options.managedDockerfilePlan;
	if (!plan) {
		return shortenBuildDetail(`dockerfile ${path.basename(options.dockerfilePath)}`);
	}
	details.push(`base ${plan.base}:${plan.baseImage.tag}`);
	if (options.imageTarget.source?.overlay) {
		details.push(`overlay ${path.basename(options.imageTarget.source.overlay)}`);
	}
	const agentVmPackages = [
		plan.openClawAgentVmPluginPackage,
		plan.openClawMcpPortalPluginPackage,
		plan.mcpPortalPackage,
	].filter(
		(packageEntry): packageEntry is ManagedDockerfilePackagePlanEntry => packageEntry !== undefined,
	);
	const agentVmPackageStatus = formatAgentVmPackageStatus(agentVmPackages);
	if (agentVmPackageStatus) {
		details.push(agentVmPackageStatus);
	}
	if (plan.openClawPackages.length > 0) {
		details.push(
			`packages ${plan.openClawPackages.map((packageEntry) => formatManagedPackagePlanEntry(packageEntry)).join(',')}`,
		);
	}
	if (plan.warnings.length > 0) {
		details.push(`warnings ${plan.warnings.length}`);
	}
	return shortenBuildDetail(details.join(' | '));
}

function normalizeDockerOutputLine(line: string): string | undefined {
	const normalizedLine = line.trim();
	if (normalizedLine.length === 0) {
		return undefined;
	}
	return normalizedLine.replace(/\s+/g, ' ');
}

function createDockerTaskOutput(
	taskContext: RunTaskContext | undefined,
	baseDetail: string | undefined,
): TaskOutput | undefined {
	if (taskContext?.interactive !== true) {
		return undefined;
	}
	return {
		write: (chunk) => {
			const line = normalizeDockerOutputLine(String(chunk));
			if (!line) {
				return true;
			}
			const detailSuffix = baseDetail ? ` | ${baseDetail}` : '';
			taskContext.setOutput(shortenBuildDetail(`${line}${detailSuffix}`));
			return true;
		},
	};
}

interface GondolinPhasePattern {
	readonly pattern: RegExp;
	readonly status: string;
}

const gondolinPhasePatterns: readonly GondolinPhasePattern[] = [
	{ pattern: /^Extracting OCI rootfs\b/, status: 'extracting OCI rootfs' },
	{
		pattern: /^Creating OCI export container\b/,
		status: 'exporting OCI rootfs',
	},
	{
		pattern: /^Extracting Alpine minirootfs for rootfs\b/,
		status: 'extracting rootfs',
	},
	{
		pattern: /^Extracting Alpine minirootfs for initramfs\b/,
		status: 'extracting initramfs',
	},
	{ pattern: /^Installing rootfs packages\b/, status: 'installing rootfs packages' },
	{ pattern: /^Installing initramfs packages\b/, status: 'installing initramfs packages' },
	{ pattern: /^Bootstrapped busybox shell\b/, status: 'bootstrapping rootfs shell' },
	{ pattern: /^Applying post-build copies\b/, status: 'applying post-build copies' },
	{ pattern: /^Running post-build command\b/, status: 'running post-build commands' },
	{ pattern: /^Syncing kernel modules\b/, status: 'copying kernel modules' },
	{ pattern: /^Creating rootfs ext4 image\b/, status: 'creating rootfs image' },
	{ pattern: /^Creating initramfs\b/, status: 'creating initramfs' },
	{ pattern: /^Rootfs image written\b/, status: 'rootfs image ready' },
	{ pattern: /^Fetching kernel\b/, status: 'fetching kernel' },
	{ pattern: /^Fetching libkrunfw-compatible kernel\b/, status: 'fetching libkrunfw kernel' },
	{ pattern: /^Copying assets to output directory\b/, status: 'copying vm assets' },
	{ pattern: /^Generating manifest\b/, status: 'generating vm manifest' },
	{ pattern: /^Build complete\b/, status: 'vm asset build complete' },
];

function parseGondolinPhaseStatus(line: string): string | undefined {
	const normalizedLine = line.trim();
	for (const phasePattern of gondolinPhasePatterns) {
		if (phasePattern.pattern.test(normalizedLine)) {
			return phasePattern.status;
		}
	}
	return undefined;
}

function createGondolinPhaseTaskOutput(
	taskContext: RunTaskContext | undefined,
	statusController: ElapsedStatusController,
): TaskOutput | undefined {
	if (taskContext?.interactive !== true) {
		return undefined;
	}
	let bufferedOutput = '';
	return {
		write: (chunk) => {
			bufferedOutput += String(chunk);
			let lineBreakIndex = bufferedOutput.indexOf('\n');
			while (lineBreakIndex !== -1) {
				const line = bufferedOutput.slice(0, lineBreakIndex);
				bufferedOutput = bufferedOutput.slice(lineBreakIndex + 1);
				const phaseStatus = parseGondolinPhaseStatus(line);
				if (phaseStatus) {
					statusController.setBaseStatus(phaseStatus);
				}
				lineBreakIndex = bufferedOutput.indexOf('\n');
			}
			if (bufferedOutput.length > TASK_OUTPUT_BUFFER_MAX_LENGTH) {
				bufferedOutput = bufferedOutput.slice(-TASK_OUTPUT_BUFFER_MAX_LENGTH);
			}
			return true;
		},
	};
}

export async function runBuildCommand(
	options: {
		readonly forceRebuild?: boolean;
		readonly systemConfig: LoadedSystemConfig;
	},
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	const buildDockerImage = dependencies.buildDockerImage ?? buildDockerImageDefault;
	const resolveDockerRootfsIdentity =
		dependencies.resolveDockerRootfsIdentity ?? resolveDockerRootfsIdentityDefault;
	const buildGondolinImage = dependencies.buildGondolinImage ?? buildGondolinImageDefault;
	const computeGondolinFingerprint =
		dependencies.computeGondolinFingerprint ??
		(async (fingerprintOptions): Promise<string> =>
			fingerprintOptions.fingerprintInput === undefined
				? await computeFingerprintFromConfigPath(fingerprintOptions.buildConfigPath)
				: await computeFingerprintFromConfigPath(fingerprintOptions.buildConfigPath, {
						fingerprintInput: fingerprintOptions.fingerprintInput,
					}));
	const deleteStaleImageDirectories =
		dependencies.deleteStaleImageDirectories ?? deleteStaleImageDirectoriesDefault;
	const findPrunableImageDirectories =
		dependencies.findPrunableImageDirectories ?? findPrunableImageDirectoriesDefault;
	const resolveOciImageTag = dependencies.resolveOciImageTag ?? resolveOciImageTagFromConfig;
	const resolveRequiredZigVersion =
		dependencies.resolveRequiredZigVersion ?? resolveGondolinCompatibleZigVersion;
	const resolveZigVersion = dependencies.resolveZigVersion ?? resolveHostZigVersion;
	const runTaskStep = dependencies.runTask ?? defaultRunTask;
	const runTaskGroup = dependencies.runTaskGroup ?? createRunTaskGroupFallback(runTaskStep);
	const resolveProjectRoot =
		dependencies.resolveProjectRootFromDockerfile ?? resolveProjectRootFromDockerfile;
	const generateManagedDockerfile =
		dependencies.generateManagedDockerfile ?? generateManagedDockerfileDefault;
	const resolveManagedImageRelease =
		dependencies.resolveManagedImageRelease ?? resolveManagedImageReleaseDefault;
	const syncBundledOpenClawPlugin =
		dependencies.syncBundledOpenClawPlugin ?? syncBundledOpenClawPluginBundle;

	if (shouldAssertZigBuildPrerequisite()) {
		await assertZigBuildPrerequisite(resolveRequiredZigVersion, resolveZigVersion);
	}

	const gatewayImageTargets: readonly ImageTarget[] = Object.entries(
		options.systemConfig.imageProfiles.gateways,
	).map(([profileName, profile]) => ({
		buildConfigPath: profile.buildConfig,
		cacheDirectory: path.join(options.systemConfig.cacheDir, 'gateway-images', profileName),
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
		dockerfile: profile.dockerfile,
		family: 'toolVm' as const,
		name: profileName,
		source: profile.source,
	}));
	const imageTargets: readonly ImageTarget[] = [...gatewayImageTargets, ...toolVmImageTargets];
	const dockerImageTargets = imageTargets.filter(
		(imageTarget) => imageTarget.dockerfile !== undefined || imageTarget.source !== undefined,
	);
	const dockerImageTagByTargetKey = await assertUniqueDockerImageTags(
		dockerImageTargets,
		resolveOciImageTag,
	);
	const managedImageRelease = dockerImageTargets.some(
		(imageTarget) => imageTarget.source !== undefined,
	)
		? await resolveManagedImageRelease()
		: undefined;

	const dockerBuildPlans: DockerBuildPlan[] = [];
	const dockerFingerprintInputByTargetKey = new Map<string, DockerBackedFingerprintInput>();

	// oxlint-disable-next-line no-await-in-loop -- Docker inputs are prepared in stable order before bounded parallel builds start
	for (const imageTarget of dockerImageTargets) {
		const imageTag = dockerImageTagByTargetKey.get(imageTargetKey(imageTarget));
		if (!imageTag) {
			throw new Error(
				`Missing resolved Docker image tag for image profile '${imageTargetKey(imageTarget)}'.`,
			);
		}
		let dockerfilePath = imageTarget.dockerfile;
		let managedDockerfilePlan: ManagedDockerfilePlan | undefined;
		if (imageTarget.source) {
			if (!managedImageRelease) {
				throw new Error('Missing managed image release for managed image build.');
			}
			// oxlint-disable-next-line no-await-in-loop -- package detection is profile-local and low-volume
			const requiredOpenClawPackageNames = await resolveRequiredOpenClawPackagesForTarget(
				options.systemConfig,
				imageTarget,
			);
			// oxlint-disable-next-line no-await-in-loop -- each generated Docker context belongs to one image target
			const managedDockerfile = await generateManagedDockerfile({
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
				requiredOpenClawPackageNames,
			});
			dockerfilePath = managedDockerfile.dockerfilePath;
			managedDockerfilePlan = managedDockerfile.plan;
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
		dockerBuildPlans.push({
			dockerfilePath,
			imageTag,
			imageTarget,
			...(managedDockerfilePlan ? { managedDockerfilePlan } : {}),
		});
	}

	await runTaskGroup(
		dockerBuildPlans.map(
			(dockerBuildPlan): RunTaskGroupTask => ({
				title: `Docker: ${dockerBuildPlan.imageTarget.family}/${dockerBuildPlan.imageTarget.name} (${dockerBuildPlan.imageTag})`,
				fn: async (taskContext) => {
					const dockerBaseDetail = formatDockerBaseDetail({
						dockerfilePath: dockerBuildPlan.dockerfilePath,
						imageTarget: dockerBuildPlan.imageTarget,
						...(dockerBuildPlan.managedDockerfilePlan
							? { managedDockerfilePlan: dockerBuildPlan.managedDockerfilePlan }
							: {}),
					});
					taskContext?.setOutput(dockerBaseDetail);
					const dockerTaskOutput = createDockerTaskOutput(taskContext, dockerBaseDetail);
					taskContext?.setStatus('docker build');
					await buildDockerImage({
						dockerfilePath: dockerBuildPlan.dockerfilePath,
						imageTag: dockerBuildPlan.imageTag,
						...(taskContext?.interactive === true ? { quiet: true } : {}),
						...(dockerTaskOutput ? { streamPreview: dockerTaskOutput } : {}),
					});
					taskContext?.setStatus('inspect layers');
					const dockerRootfsIdentity = await resolveDockerRootfsIdentity(dockerBuildPlan.imageTag);
					if (!dockerRootfsIdentity) {
						throw new Error(
							`Docker image '${dockerBuildPlan.imageTag}' was built but its rootfs identity could not be inspected.`,
						);
					}
					dockerFingerprintInputByTargetKey.set(imageTargetKey(dockerBuildPlan.imageTarget), {
						dockerRootfsIdentity,
						schemaVersion: 1,
					});
					taskContext?.setStatus('docker image ready');
				},
			}),
		),
		{ concurrency: DOCKER_BUILD_CONCURRENCY },
	);
	const currentFingerprints = createEmptyCurrentImageFingerprints();
	const fingerprintByInputKey = new Map<string, string>();
	const targetPlans: GondolinTargetPlan[] = [];
	const targetPlansByDedupeKey = new Map<string, GondolinTargetPlan[]>();

	for (const imageTarget of imageTargets) {
		const key = imageTargetKey(imageTarget);
		const fingerprintInput = dockerFingerprintInputByTargetKey.get(key);
		const fingerprintInputKey = imageTargetFingerprintInputKey({
			buildConfigPath: imageTarget.buildConfigPath,
			fingerprintInput,
		});
		let fingerprint = fingerprintByInputKey.get(fingerprintInputKey);
		if (fingerprint === undefined) {
			// oxlint-disable-next-line no-await-in-loop -- fingerprint errors should identify the matching profile path
			fingerprint = await computeGondolinFingerprint({
				buildConfigPath: imageTarget.buildConfigPath,
				...(fingerprintInput === undefined ? {} : { fingerprintInput }),
			});
			fingerprintByInputKey.set(fingerprintInputKey, fingerprint);
		}
		const dedupeKey = imageTargetDedupeKey({
			buildConfigPath: imageTarget.buildConfigPath,
			fingerprint,
		});
		const shouldResetGondolinCache = options.forceRebuild === true;
		const targetPlan: GondolinTargetPlan = {
			dedupeKey,
			fingerprint,
			fingerprintInput,
			imageTarget,
			key,
			sharedDedupeKey: false,
			shouldResetGondolinCache,
		};
		targetPlans.push(targetPlan);
		targetPlansByDedupeKey.set(dedupeKey, [
			...(targetPlansByDedupeKey.get(dedupeKey) ?? []),
			targetPlan,
		]);
	}
	for (const sharedTargetPlans of targetPlansByDedupeKey.values()) {
		const shouldResetGondolinCache = sharedTargetPlans.some(
			(targetPlan) => targetPlan.shouldResetGondolinCache,
		);
		for (const targetPlan of sharedTargetPlans) {
			targetPlan.sharedDedupeKey = sharedTargetPlans.length > 1;
			targetPlan.shouldResetGondolinCache = shouldResetGondolinCache;
		}
	}
	const builtImageByDedupeKey = new Map<string, BuiltImageCacheEntry>();
	const canonicalTargetPlans = [...targetPlansByDedupeKey.values()].map(firstGondolinTargetPlan);
	const builtImageResults: BuiltImagePlanResult[] = [];

	await runTaskGroup(
		canonicalTargetPlans.map(
			(targetPlan): RunTaskGroupTask => ({
				title: `Gondolin: ${targetPlan.imageTarget.family}/${targetPlan.imageTarget.name}`,
				fn: async (taskContext) => {
					const statusController = startElapsedStatusController(
						taskContext,
						targetPlan.shouldResetGondolinCache ? 'building vm assets' : 'checking vm assets',
					);
					const gondolinTaskOutput = createGondolinPhaseTaskOutput(taskContext, statusController);
					let result: BuildImageResult;
					try {
						result = await buildGondolinImage({
							buildConfigPath: targetPlan.imageTarget.buildConfigPath,
							cacheDir: targetPlan.imageTarget.cacheDirectory,
							...(targetPlan.fingerprintInput === undefined
								? {}
								: { fingerprintInput: targetPlan.fingerprintInput }),
							...(targetPlan.shouldResetGondolinCache ? { fullReset: true } : {}),
							...(gondolinTaskOutput ? { streamPreview: gondolinTaskOutput } : {}),
						});
					} finally {
						statusController.stop();
					}
					if (targetPlan.sharedDedupeKey && result.fingerprint !== targetPlan.fingerprint) {
						throw new Error(
							`Fingerprint mismatch for image profile '${targetPlan.key}': precomputed '${targetPlan.fingerprint}' but build returned '${result.fingerprint}'.`,
						);
					}
					builtImageResults.push({
						imageTarget: targetPlan.imageTarget,
						result,
						targetPlan,
					});
					taskContext?.setStatus(result.built ? 'vm assets ready' : 'vm assets cache hit');
				},
			}),
		),
		{ concurrency: GONDOLIN_BUILD_CONCURRENCY },
	);

	for (const builtImageResult of builtImageResults) {
		builtImageByDedupeKey.set(builtImageResult.targetPlan.dedupeKey, {
			imageTarget: builtImageResult.imageTarget,
			result: builtImageResult.result,
		});
	}

	for (const targetPlan of targetPlans) {
		const existingBuild = builtImageByDedupeKey.get(targetPlan.dedupeKey);
		if (!existingBuild) {
			throw new Error(`Missing built image result for image profile '${targetPlan.key}'.`);
		}
		// oxlint-disable-next-line no-await-in-loop -- alias materialization is kept deterministic so duplicate-profile errors name the matching profile
		const imagePath = await materializePreparedTargetImage({
			fingerprint: existingBuild.result.fingerprint,
			fullReset: targetPlan.shouldResetGondolinCache,
			sourceImagePath: existingBuild.result.imagePath,
			targetCacheDirectory: targetPlan.imageTarget.cacheDirectory,
		});
		// oxlint-disable-next-line no-await-in-loop -- prepared records are profile-local and must report the matching profile path on failure
		await writePreparedGondolinImage({
			buildConfigPath: targetPlan.imageTarget.buildConfigPath,
			cacheDir: targetPlan.imageTarget.cacheDirectory,
			fingerprint: existingBuild.result.fingerprint,
			fingerprintInput: targetPlan.fingerprintInput,
			imagePath,
		});
		setCurrentImageFingerprint(
			currentFingerprints,
			targetPlan.imageTarget,
			existingBuild.result.fingerprint,
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
