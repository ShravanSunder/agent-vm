import path from 'node:path';

import { z } from 'zod';

import {
	buildDockerImage as buildDockerImageDefault,
	resolveDockerRootfsIdentity as resolveDockerRootfsIdentityDefault,
	type DockerRootfsIdentity,
} from '../build/docker-image-builder.js';
import {
	buildManagedVmImage as buildManagedVmImageDefault,
	computeFingerprintFromConfigPath,
} from '../build/gondolin-image-builder.js';
import type { ManagedGatewayImageBootProjection } from '../build/gondolin-managed-vm-build-tooling.js';

interface ManagedVmBackendImageBuildResult {
	readonly built: boolean;
	readonly fingerprint: string;
	readonly imagePath: string;
}
import {
	generateManagedDockerfile as generateManagedDockerfileDefault,
	resolveManagedImageRelease as resolveManagedImageReleaseDefault,
	type GenerateManagedDockerfileResult,
	type ManagedDockerfilePackagePlanEntry,
	type ManagedDockerfilePlan,
	type ManagedImageRelease,
	type ManagedImageSource,
} from '../build/managed-image-dockerfile.js';
import {
	configuredImageSelectionRecordPath,
	writePreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import {
	assertManagedVmZigCompatibility,
	resolveManagedVmCompatibleZigVersion,
	resolveHostZigVersion,
} from '../build/zig-compatibility.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import {
	deploymentCacheDirForSystemConfig,
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForSystemConfig,
	type LoadedSystemConfig,
} from '../config/system-config.js';
import { scanLegacyControllerRecordEvidence as scanGatewayStateAuthorityEvidenceDefault } from '../controller/durable-state/legacy-controller-record-evidence.js';
import { createObservabilityRuntimeConfig } from '../observability/observability-config.js';
import {
	prepareObservabilityStack as prepareObservabilityStackDefault,
	resolveBuildObservabilityConfig,
	type PrepareObservabilityStackOptions,
	type PrepareObservabilityStackResult,
} from '../observability/observability-lifecycle.js';
import type {
	RunTaskContext,
	RunTaskFn,
	RunTaskGroupFn,
	RunTaskGroupTask,
	TaskOutput,
} from '../shared/run-task.js';
import { formatZodError } from './format-zod-error.js';

export interface BuildCommandDependencies {
	readonly buildDockerImage?: (options: {
		readonly dockerfilePath: string;
		readonly imageTag: string;
		readonly quiet?: boolean;
		readonly streamPreview?: TaskOutput;
	}) => Promise<void>;
	readonly buildManagedVmImage?: (options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fingerprintInput?: unknown;
		readonly fullReset?: boolean;
		readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
		readonly streamPreview?: TaskOutput;
	}) => Promise<ManagedVmBackendImageBuildResult>;
	readonly computeManagedVmFingerprint?: (options: {
		readonly buildConfigPath: string;
		readonly fingerprintInput?: unknown;
		readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	}) => Promise<string>;
	readonly resolveOciImageTag?: (buildConfigPath: string) => Promise<string>;
	readonly resolveDockerRootfsIdentity?: (
		imageTag: string,
	) => Promise<DockerRootfsIdentity | undefined>;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
	/** Override the task runner for testing or custom CLI progress. */
	readonly runTask?: RunTaskFn;
	readonly runTaskGroup?: RunTaskGroupFn;
	readonly generateManagedDockerfile?: (options: {
		readonly base: ManagedImageSource['base'];
		readonly imageTargetFamily: 'gateway' | 'toolVm';
		readonly imageTargetName: string;
		readonly outputDirectory: string;
		readonly overlayPath?: string | undefined;
		readonly managedImageRelease: ManagedImageRelease;
	}) => Promise<GenerateManagedDockerfileResult>;
	readonly resolveManagedImageRelease?: () => Promise<ManagedImageRelease>;
	readonly prepareObservabilityStack?: (
		options: PrepareObservabilityStackOptions,
	) => Promise<PrepareObservabilityStackResult>;
	readonly scanGatewayStateAuthorityEvidence?: typeof scanGatewayStateAuthorityEvidenceDefault;
}

const ociImageTagSchema = z.object({
	oci: z.object({
		image: z.string().min(1),
	}),
});

const DOCKER_BUILD_CONCURRENCY = 2;
const GONDOLIN_BUILD_CONCURRENCY = 2;
const BUILD_DETAIL_MAX_LENGTH = 512;
const GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE_ENV = 'GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE';
const TASK_OUTPUT_BUFFER_MAX_LENGTH = 4_096;
interface ImageTarget {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
	readonly dockerfile: string | undefined;
	readonly family: 'gateway' | 'toolVm';
	readonly gatewayType?: ManagedGatewayBootGatewayType;
	readonly name: string;
	readonly selectionRecordPath: string;
	readonly source: ManagedImageSource | undefined;
}

type ManagedGatewayBootGatewayType = 'hermes' | 'worker';

interface BuiltImageCacheEntry {
	readonly imageTarget: ImageTarget;
	readonly result: ManagedVmBackendImageBuildResult;
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
	readonly result: ManagedVmBackendImageBuildResult;
}

interface GondolinTargetPlan {
	readonly dedupeKey: string;
	readonly fingerprint: string;
	readonly imageTarget: ImageTarget;
	readonly fingerprintInput?: unknown;
	readonly key: string;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	sharedDedupeKey: boolean;
	shouldResetGondolinCache: boolean;
}

const imageTargetKeySeparator = '\0';

function imageTargetKey(imageTarget: Pick<ImageTarget, 'family' | 'name'>): string {
	return `${imageTarget.family}/${imageTarget.name}`;
}

function imageTargetDedupeKey(options: { readonly fingerprint: string }): string {
	return options.fingerprint;
}

function imageTargetFingerprintInputKey(options: {
	readonly buildConfigPath: string;
	readonly fingerprintInput?: unknown;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
}): string {
	return `${path.resolve(options.buildConfigPath)}${imageTargetKeySeparator}${JSON.stringify({ fingerprintInput: options.fingerprintInput ?? null, managedGatewayBoot: options.managedGatewayBoot ?? null })}`;
}

export function managedGatewayBootProjectionForGatewayType(
	gatewayType: ManagedGatewayBootGatewayType,
): ManagedGatewayImageBootProjection | undefined {
	switch (gatewayType) {
		case 'hermes':
			return {
				frameworkBootEntry: 'hermes-framework-service',
				kind: 'managed-gateway-exact-two-role',
			};
		case 'worker':
			return undefined;
	}
}

function managedGatewayBootProjectionForImageTarget(
	imageTarget: ImageTarget,
): ManagedGatewayImageBootProjection | undefined {
	return imageTarget.family === 'gateway' && imageTarget.gatewayType !== undefined
		? managedGatewayBootProjectionForGatewayType(imageTarget.gatewayType)
		: undefined;
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
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) {
				return;
			}
			const item = items[index];
			if (item === undefined) {
				throw new Error(`Expected build queue item at index ${index}.`);
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

type GatewayStateAuthorityEvidence = Awaited<
	ReturnType<typeof scanGatewayStateAuthorityEvidenceDefault>
>[number];

function formatGatewayStateAuthorityEvidence(evidence: GatewayStateAuthorityEvidence): string {
	return `${evidence.family}:${evidence.kind}:${evidence.absolutePath}`;
}

async function assertGatewayStateAuthorityIsCurrent(
	systemConfig: LoadedSystemConfig,
	scanGatewayStateAuthorityEvidence: typeof scanGatewayStateAuthorityEvidenceDefault,
): Promise<void> {
	const evidenceByZone: {
		readonly evidence: readonly GatewayStateAuthorityEvidence[];
		readonly zoneId: string;
	}[] = [];
	for (const zone of systemConfig.zones) {
		// oxlint-disable-next-line no-await-in-loop -- scan every zone in stable configuration order before any build mutation.
		const evidence = await scanGatewayStateAuthorityEvidence({
			gatewayStateDirectoryPath: zone.gateway.stateDir,
		});
		if (evidence.length > 0) {
			evidenceByZone.push({ evidence, zoneId: zone.id });
		}
	}
	if (evidenceByZone.length === 0) {
		return;
	}
	throw new Error(
		evidenceByZone
			.map(
				({ evidence, zoneId }) =>
					`Legacy controller record evidence exists under Gateway state for zone '${zoneId}': ${evidence.map(formatGatewayStateAuthorityEvidence).join('; ')}`,
			)
			.join('\n'),
	);
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
	assertManagedVmZigCompatibility({
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
	return unversionedSpec.replace(/^@agent-vm\//, '');
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
	const agentVmPackages = [plan.mcpPortalPackage].filter(
		(packageEntry): packageEntry is ManagedDockerfilePackagePlanEntry => packageEntry !== undefined,
	);
	const agentVmPackageStatus = formatAgentVmPackageStatus(agentVmPackages);
	if (agentVmPackageStatus) {
		details.push(agentVmPackageStatus);
	}
	if (plan.directNpmPackages.length > 0) {
		details.push(
			`npm ${plan.directNpmPackages.map((packageEntry) => formatManagedPackagePlanEntry(packageEntry)).join(',')}`,
		);
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
		readonly skipObservability?: boolean;
		readonly systemConfig: LoadedSystemConfig;
	},
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	const buildDockerImage = dependencies.buildDockerImage ?? buildDockerImageDefault;
	const resolveDockerRootfsIdentity =
		dependencies.resolveDockerRootfsIdentity ?? resolveDockerRootfsIdentityDefault;
	const buildManagedVmImage = dependencies.buildManagedVmImage ?? buildManagedVmImageDefault;
	const computeManagedVmFingerprint =
		dependencies.computeManagedVmFingerprint ??
		(async (fingerprintOptions): Promise<string> =>
			await computeFingerprintFromConfigPath(fingerprintOptions.buildConfigPath, {
				...(fingerprintOptions.fingerprintInput === undefined
					? {}
					: { fingerprintInput: fingerprintOptions.fingerprintInput }),
				...(fingerprintOptions.managedGatewayBoot === undefined
					? {}
					: { managedGatewayBoot: fingerprintOptions.managedGatewayBoot }),
			}));
	const resolveOciImageTag = dependencies.resolveOciImageTag ?? resolveOciImageTagFromConfig;
	const resolveRequiredZigVersion =
		dependencies.resolveRequiredZigVersion ?? resolveManagedVmCompatibleZigVersion;
	const resolveZigVersion = dependencies.resolveZigVersion ?? resolveHostZigVersion;
	const runTaskStep = dependencies.runTask ?? defaultRunTask;
	const runTaskGroup = dependencies.runTaskGroup ?? createRunTaskGroupFallback(runTaskStep);
	const generateManagedDockerfile =
		dependencies.generateManagedDockerfile ?? generateManagedDockerfileDefault;
	const resolveManagedImageRelease =
		dependencies.resolveManagedImageRelease ?? resolveManagedImageReleaseDefault;
	const prepareObservabilityStack =
		dependencies.prepareObservabilityStack ?? prepareObservabilityStackDefault;
	const scanGatewayStateAuthorityEvidence =
		dependencies.scanGatewayStateAuthorityEvidence ?? scanGatewayStateAuthorityEvidenceDefault;

	await assertGatewayStateAuthorityIsCurrent(
		options.systemConfig,
		scanGatewayStateAuthorityEvidence,
	);

	if (shouldAssertZigBuildPrerequisite()) {
		await assertZigBuildPrerequisite(resolveRequiredZigVersion, resolveZigVersion);
	}

	const sharedImageCacheDir = sharedImageCacheDirForSystemConfig(options.systemConfig);
	const deploymentGeneratedDir = deploymentGeneratedDirForStorageRoot(
		options.systemConfig.storageRootDir,
	);
	const deploymentCacheDir = deploymentCacheDirForSystemConfig(options.systemConfig);
	const gatewayImageTargets: readonly ImageTarget[] = Object.entries(
		options.systemConfig.imageProfiles.gateways,
	).map(([profileName, profile]) => ({
		buildConfigPath: profile.buildConfig,
		cacheDirectory: sharedImageCacheDir,
		dockerfile: profile.dockerfile,
		family: 'gateway' as const,
		gatewayType: profile.type,
		name: profileName,
		selectionRecordPath: configuredImageSelectionRecordPath({
			deploymentGeneratedDir,
			family: 'gateway',
			profileName,
		}),
		source: profile.source,
	}));
	const toolVmImageTargets: readonly ImageTarget[] = Object.entries(
		options.systemConfig.imageProfiles.toolVms,
	).map(([profileName, profile]) => ({
		buildConfigPath: profile.buildConfig,
		cacheDirectory: sharedImageCacheDir,
		dockerfile: profile.dockerfile,
		family: 'toolVm' as const,
		name: profileName,
		selectionRecordPath: configuredImageSelectionRecordPath({
			deploymentGeneratedDir,
			family: 'toolVm',
			profileName,
		}),
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
			// oxlint-disable-next-line no-await-in-loop -- each generated Docker context belongs to one image target
			const managedDockerfile = await generateManagedDockerfile({
				base: imageTarget.source.base,
				imageTargetFamily: imageTarget.family,
				imageTargetName: imageTarget.name,
				outputDirectory: path.join(
					deploymentCacheDir,
					'docker-contexts',
					imageTarget.family,
					imageTarget.name,
				),
				...(imageTarget.source.overlay ? { overlayPath: imageTarget.source.overlay } : {}),
				managedImageRelease,
			});
			dockerfilePath = managedDockerfile.dockerfilePath;
			managedDockerfilePlan = managedDockerfile.plan;
		}
		if (!dockerfilePath) {
			throw new Error(`Missing Dockerfile path for image profile '${imageTarget.name}'.`);
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
	const fingerprintByInputKey = new Map<string, string>();
	const targetPlans: GondolinTargetPlan[] = [];
	const targetPlansByDedupeKey = new Map<string, GondolinTargetPlan[]>();

	for (const imageTarget of imageTargets) {
		const key = imageTargetKey(imageTarget);
		const fingerprintInput = dockerFingerprintInputByTargetKey.get(key);
		const managedGatewayBoot = managedGatewayBootProjectionForImageTarget(imageTarget);
		const fingerprintInputKey = imageTargetFingerprintInputKey({
			buildConfigPath: imageTarget.buildConfigPath,
			fingerprintInput,
			...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
		});
		let fingerprint = fingerprintByInputKey.get(fingerprintInputKey);
		if (fingerprint === undefined) {
			// oxlint-disable-next-line no-await-in-loop -- fingerprint errors should identify the matching profile path
			fingerprint = await computeManagedVmFingerprint({
				buildConfigPath: imageTarget.buildConfigPath,
				...(fingerprintInput === undefined ? {} : { fingerprintInput }),
				...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
			});
			fingerprintByInputKey.set(fingerprintInputKey, fingerprint);
		}
		const dedupeKey = imageTargetDedupeKey({
			fingerprint,
		});
		const shouldResetGondolinCache = options.forceRebuild === true;
		const targetPlan: GondolinTargetPlan = {
			dedupeKey,
			fingerprint,
			fingerprintInput,
			imageTarget,
			key,
			...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
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
					let result: ManagedVmBackendImageBuildResult;
					try {
						result = await buildManagedVmImage({
							buildConfigPath: targetPlan.imageTarget.buildConfigPath,
							cacheDir: targetPlan.imageTarget.cacheDirectory,
							...(targetPlan.fingerprintInput === undefined
								? {}
								: { fingerprintInput: targetPlan.fingerprintInput }),
							...(targetPlan.managedGatewayBoot === undefined
								? {}
								: { managedGatewayBoot: targetPlan.managedGatewayBoot }),
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
		// oxlint-disable-next-line no-await-in-loop -- prepared records are profile-local and must report the matching profile path on failure
		await writePreparedManagedVmImage({
			buildConfigPath: targetPlan.imageTarget.buildConfigPath,
			fingerprint: existingBuild.result.fingerprint,
			fingerprintInput: targetPlan.fingerprintInput,
			imagePath: existingBuild.result.imagePath,
			selectionRecordPath: targetPlan.imageTarget.selectionRecordPath,
			sharedImageCacheDir,
			...(targetPlan.managedGatewayBoot === undefined
				? {}
				: { managedGatewayBoot: targetPlan.managedGatewayBoot }),
		});
	}

	if (options.skipObservability === true) {
		await runTaskStep('Observability stack', async (taskContext) => {
			taskContext?.setStatus('observability stack skipped');
			taskContext?.setOutput({
				message: 'Host observability preparation skipped for this build run (--no-observability).',
			});
		});
		return;
	}

	const runtimeObservabilityConfig = createObservabilityRuntimeConfig(options.systemConfig);
	if (!runtimeObservabilityConfig.enabled) {
		if (options.systemConfig.host.observability?.enabled !== false) {
			return;
		}
		await runTaskStep('Observability stack', async (taskContext) => {
			taskContext?.setStatus('observability disabled');
			taskContext?.setOutput({
				message: 'Host observability disabled for this deployment.',
			});
		});
		return;
	}

	if (!runtimeObservabilityConfig.prepareOnBuild) {
		await runTaskStep('Observability stack', async (taskContext) => {
			taskContext?.setStatus('observability stack skipped');
			taskContext?.setOutput({
				message: 'Host observability preparation skipped because prepareOnBuild is false.',
			});
		});
		return;
	}

	if (runtimeObservabilityConfig.stackMode === 'external') {
		await runTaskStep('Observability stack', async (taskContext) => {
			taskContext?.setStatus('external observability stack');
			taskContext?.setOutput({
				message:
					'Host observability uses an external observability stack; Docker Compose is not managed by this deployment.',
			});
		});
		return;
	}

	if (runtimeObservabilityConfig.zones.length === 0) {
		await runTaskStep('Observability stack', async (taskContext) => {
			taskContext?.setStatus('observability stack skipped');
			taskContext?.setOutput({
				message: 'Host observability preparation skipped because no Hermes zone opted in.',
			});
		});
		return;
	}

	const observabilityConfig = resolveBuildObservabilityConfig(options.systemConfig);
	if (observabilityConfig !== undefined) {
		await runTaskStep('Observability stack', async (taskContext) => {
			taskContext?.setStatus(
				observabilityConfig.waitOnBuild
					? 'starting observability stack and waiting'
					: 'starting observability stack',
			);
			const result = await prepareObservabilityStack({
				config: observabilityConfig,
				wait: observabilityConfig.waitOnBuild,
			});
			taskContext?.setStatus(
				result.status === 'ready' ? 'observability stack ready' : 'observability stack started',
			);
			taskContext?.setOutput({
				message: `Host observability stack ${result.status}. Rendered ${path.basename(result.composePath)} and ${path.basename(result.collectorConfigPath)}.`,
			});
		});
	}
}
