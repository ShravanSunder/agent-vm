import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as waitForRetryInterval } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import {
	hasManagedVmImageAssets,
	resolveManagedVmMinimumZigVersion,
	type ManagedGatewayImageBootProjection,
} from '../build/gondolin-managed-vm-build-tooling.js';
import {
	generateManagedDockerfile,
	loadManagedImageOverlay,
	resolveManagedImageRelease,
	type ManagedImageOverlay,
} from '../build/managed-image-dockerfile.js';
import {
	readPreparedManagedVmImage,
	writePreparedManagedVmImage,
	type PreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import { isZigVersionAtLeast, resolveHostZigVersion } from '../build/zig-compatibility.js';
import { runBuildCommand } from '../cli/build-command.js';
import { scaffoldAgentVmProject, type ImageArchitecture } from '../cli/init-command.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import { loadSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type {
	ControllerRuntime,
	ControllerRuntimeDependencies,
	StartControllerRuntimeOptions,
} from '../controller/controller-runtime-types.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import {
	startGatewayZone as startGatewayZoneDefault,
	startGatewayZoneForController as startGatewayZoneForControllerDefault,
} from '../gateway/gateway-zone-orchestrator.js';
import type {
	GatewayControlSessionConnector,
	StartGatewayZoneOptions,
} from '../gateway/gateway-zone-support.js';
import { controllerFixedGatewayRuntimeArtifactLimits } from '../gateway/managed-gateway-runtime-input-builders.js';

const managedVmRuntimeComposition = createManagedVmRuntimeComposition();

export async function startE2eGatewayZone(
	options: StartGatewayZoneOptions,
	testHooks: {
		readonly onManagedVmCreateRequest?: (request: ManagedVmCreateRequest) => void;
	} = {},
): Promise<Awaited<ReturnType<typeof startGatewayZoneDefault>>> {
	const managedVmFactory =
		testHooks.onManagedVmCreateRequest === undefined
			? managedVmRuntimeComposition.managedVmFactory
			: {
					createManagedVm: async (request: ManagedVmCreateRequest) => {
						testHooks.onManagedVmCreateRequest?.(request);
						return await managedVmRuntimeComposition.managedVmFactory.createManagedVm(request);
					},
				};
	return await startGatewayZoneDefault(options, {
		...managedVmRuntimeComposition,
		gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
		managedVmFactory,
	});
}

export async function startE2eGatewayZoneForController(
	options: Parameters<typeof startGatewayZoneForControllerDefault>[0],
	testHooks: {
		readonly connectGatewayControlSession?: GatewayControlSessionConnector;
	} = {},
): Promise<Awaited<ReturnType<typeof startGatewayZoneForControllerDefault>>> {
	return await startGatewayZoneForControllerDefault(options, {
		...managedVmRuntimeComposition,
		...(testHooks.connectGatewayControlSession === undefined
			? {}
			: { connectGatewayControlSession: testHooks.connectGatewayControlSession }),
		gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
	});
}

interface OpenClawE2eZone extends Omit<LoadedSystemConfig['zones'][number], 'gateway'> {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'openclaw' }
	>;
}

interface WorkerE2eZone extends Omit<LoadedSystemConfig['zones'][number], 'gateway'> {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'worker' }
	>;
}

interface LocalNpmPackageTarball {
	readonly packageDirectory: string;
	readonly packageName: string;
}

export interface LocalDockerPackageTarball {
	readonly archiveName: string;
	readonly packageName: string;
	readonly sourcePath: string;
}

interface LocalPackagePackPlanFile {
	readonly path: string;
}

interface LocalPackagePackPlan {
	readonly filename: string;
	readonly files: readonly LocalPackagePackPlanFile[];
	readonly name: string;
	readonly version: string;
}

interface E2eImageTarget {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
	readonly dockerfile?: string;
	readonly e2eManifestEligible: boolean;
	readonly family: 'gateway' | 'toolVm';
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	readonly name: string;
	readonly recipeFingerprint: string;
	readonly source?: unknown;
}

interface E2ePreparedImageManifestEntry {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
	readonly family: 'gateway' | 'toolVm';
	readonly fingerprint: string;
	readonly fingerprintInput?: unknown;
	readonly imagePath: string;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	readonly name: string;
	readonly recipeFingerprint: string;
}

interface E2ePreparedImageManifest {
	readonly entries: readonly E2ePreparedImageManifestEntry[];
	readonly schemaVersion: 2;
}

const defaultOpenClawMcpPortalExtensionsPath = '/home/openclaw/.openclaw/extensions/mcp-portal';
const dockerContextLocalPackageTimestamp = new Date('2000-01-01T00:00:00.000Z');
const e2ePreparedImageManifestFileName = 'prepared-e2e-images.json';
const e2ePreparedImageManifestSchemaVersion = 2;
const execFileAsync = promisify(execFile);
const openClawMcpPortalPluginName = 'mcp-portal';
const e2eTempRootPrefixes = [
	'agent-vm-gateway-e2e-project-',
	'agent-vm-e2e-harness-',
	'openclaw-control-link-e2e-',
	'openclaw-control-session-e2e-',
	'openclaw-mcp-portal-e2e-',
	'openclaw-process-recovery-e2e-',
	'openclaw-subagent-lease-e2e-',
	'openclaw-workspace-git-e2e-',
	'hermes-managed-base-environment-e2e-',
	'worker-loop-e2e-',
] as const;

export function resolveE2eCacheRoot(): string {
	const configuredCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
	if (configuredCacheRoot !== undefined && configuredCacheRoot.length > 0) {
		return path.resolve(configuredCacheRoot);
	}
	return path.join(os.tmpdir(), 'agent-vm-e2e-cache');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface E2eHarnessSecretMap {
	readonly [secretKey: string]: string;
}

export interface E2eHarnessRuntime {
	readonly controllerUrl: string;
	readonly runtime: ControllerRuntime;
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
	close(options?: E2eHarnessCloseOptions): Promise<void>;
}

export interface E2eHarnessCloseOptions {
	readonly cleanupImages?: boolean;
	readonly preserveTempRoot?: boolean;
}

export interface E2eHarnessImageCleanupOptions extends E2eHarnessCloseOptions {
	readonly env?: Partial<Record<'AGENT_VM_E2E_CLEAN_IMAGES', string>>;
}

export interface OpenClawE2eProject {
	readonly controllerPort: number;
	readonly gatewayPort: number;
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
	readonly zone: OpenClawE2eZone;
}

export interface WorkerE2eProject {
	readonly controllerPort: number;
	readonly gatewayPort: number;
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
	readonly zone: WorkerE2eZone;
}

export type GatewayE2eKind = 'openclaw' | 'worker';

export type GatewayE2eProject = OpenClawE2eProject | WorkerE2eProject;

export interface GatewayE2eImageProject {
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
}

export interface ScaffoldGatewayE2eProjectOptions {
	readonly agents?: readonly string[];
	readonly architecture: ImageArchitecture;
	readonly kind: GatewayE2eKind;
	readonly prefix: string;
	readonly zoneId: string;
}

export interface ManagedVmE2ePrerequisiteOptions {
	readonly architecture: ImageArchitecture;
	readonly commandExists?: (command: string) => boolean;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
}

export interface PrepareGatewayE2eProjectImagesOptions {
	readonly imageFamilies?: readonly E2eImageTarget['family'][];
	readonly project: GatewayE2eImageProject;
	readonly runBuild?: typeof runBuildCommand;
}

export interface StartE2eControllerRuntimeOptions {
	readonly onControllerManagedVmCreateRequest?: (request: ManagedVmCreateRequest) => void;
	readonly onLeaseCreateRequest?: ControllerRuntimeDependencies['onLeaseCreateRequest'];
	readonly secrets: E2eHarnessSecretMap;
	readonly startGatewayZone?: ControllerRuntimeDependencies['startGatewayZone'];
	readonly startHttpServer?: NonNullable<ControllerRuntimeDependencies['startHttpServer']>;
	readonly startOptions: StartControllerRuntimeOptions;
	readonly tcpHostsOverride?: StartGatewayZoneOptions['tcpHostsOverride'];
	readonly vfsMountsOverride?: StartGatewayZoneOptions['vfsMountsOverride'];
}

export interface RemoveE2eDockerImagesOptions {
	readonly runDockerCommand?: (args: readonly string[]) => Promise<void>;
}

export function shouldCleanupE2eDockerImages(options: E2eHarnessImageCleanupOptions = {}): boolean {
	const env = options.env ?? process.env;
	return options.cleanupImages === true || env.AGENT_VM_E2E_CLEAN_IMAGES === '1';
}

export function hasCommand(command: string): boolean {
	try {
		execFileSync('sh', ['-lc', `command -v ${command} >/dev/null`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

export function currentE2eArchitecture(): ImageArchitecture {
	return process.arch === 'arm64' ? 'aarch64' : 'x86_64';
}

export function qemuCommandForArchitecture(architecture: ImageArchitecture): string {
	return architecture === 'aarch64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64';
}

function isOwnedE2eTempRoot(tempRoot: string): boolean {
	const resolvedTempRoot = path.resolve(tempRoot);
	const resolvedSystemTempRoot = path.resolve(os.tmpdir());
	if (
		resolvedTempRoot === resolvedSystemTempRoot ||
		!resolvedTempRoot.startsWith(`${resolvedSystemTempRoot}${path.sep}`)
	) {
		return false;
	}
	const basename = path.basename(resolvedTempRoot);
	return e2eTempRootPrefixes.some((prefix) => basename.startsWith(prefix));
}

export async function removeE2eTempRoot(tempRoot: string): Promise<void> {
	if (!isOwnedE2eTempRoot(tempRoot)) {
		return;
	}
	await fs.rm(tempRoot, { force: true, recursive: true });
}

export async function canRunManagedVmE2e(
	options: ManagedVmE2ePrerequisiteOptions,
): Promise<boolean> {
	const commandExists = options.commandExists ?? hasCommand;
	if (
		!commandExists(qemuCommandForArchitecture(options.architecture)) ||
		!commandExists('docker')
	) {
		return false;
	}
	const requiredZigVersion = await (
		options.resolveRequiredZigVersion ?? resolveManagedVmMinimumZigVersion
	)();
	const installedZigVersion = await (options.resolveZigVersion ?? resolveHostZigVersion)();
	return (
		installedZigVersion !== undefined &&
		isZigVersionAtLeast(installedZigVersion, requiredZigVersion)
	);
}

export async function shouldRunWorkerGatewayE2e(options: {
	readonly architecture: ImageArchitecture;
	readonly commandExists?: (command: string) => boolean;
	readonly env?: Partial<Record<'AGENT_VM_WORKER_E2E' | 'AGENT_VM_TEST_OPENAI_API_KEY', string>>;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
}): Promise<boolean> {
	const env = options.env ?? process.env;
	if (
		env.AGENT_VM_WORKER_E2E !== '1' ||
		typeof env.AGENT_VM_TEST_OPENAI_API_KEY !== 'string' ||
		env.AGENT_VM_TEST_OPENAI_API_KEY.length === 0
	) {
		return false;
	}
	return await canRunManagedVmE2e({
		architecture: options.architecture,
		...(options.commandExists ? { commandExists: options.commandExists } : {}),
		...(options.resolveRequiredZigVersion
			? { resolveRequiredZigVersion: options.resolveRequiredZigVersion }
			: {}),
		...(options.resolveZigVersion ? { resolveZigVersion: options.resolveZigVersion } : {}),
	});
}

export async function findAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to determine an available port.')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

function readNodeNetworkErrorCode(error: unknown): string | null {
	if (!(error instanceof TypeError) || error.message !== 'fetch failed') {
		return null;
	}
	const cause = error.cause;
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
		return null;
	}
	return typeof cause.code === 'string' ? cause.code : null;
}

function isRecoverableControllerReadyError(error: unknown): boolean {
	return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(
		readNodeNetworkErrorCode(error) ?? '',
	);
}

export async function waitForControllerReady(controllerPort: number): Promise<void> {
	const timeoutMs = 5_000;
	const retryIntervalMs = 50;
	const startedAtMs = performance.now();
	let lastError = 'not attempted';
	while (performance.now() - startedAtMs <= timeoutMs) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- controller startup readiness must observe sequential protocol state.
			const response = await fetch(`http://127.0.0.1:${String(controllerPort)}/controller-status`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) {
				return;
			}
			lastError = `HTTP ${String(response.status)}`;
		} catch (error) {
			if (!isRecoverableControllerReadyError(error)) {
				throw error;
			}
			lastError = error instanceof Error ? error.message : String(error);
		}
		// oxlint-disable-next-line no-await-in-loop -- controller readiness has no event source from the subprocess boundary.
		await waitForRetryInterval(retryIntervalMs);
	}
	throw new Error(
		`Controller did not report ready within ${String(timeoutMs)}ms. Last error: ${lastError}`,
	);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function listDirectoryFiles(directoryPath: string): Promise<readonly string[]> {
	const entries = await fs.readdir(directoryPath, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				return await listDirectoryFiles(entryPath);
			}
			return entry.isFile() ? [entryPath] : [];
		}),
	);
	return files.flat().toSorted((leftPath, rightPath) => leftPath.localeCompare(rightPath));
}

async function hashFileInto(
	hasher: crypto.Hash,
	filePath: string,
	baseDirectory: string,
): Promise<void> {
	const relativePath = path.relative(baseDirectory, filePath).split(path.sep).join('/');
	hasher.update(`file:${relativePath}\0`);
	hasher.update(await fs.readFile(filePath));
	hasher.update('\0');
}

async function computeDockerContextFingerprint(dockerfilePath: string): Promise<string> {
	const dockerContextDirectory = path.dirname(dockerfilePath);
	const hasher = crypto.createHash('sha256');
	for (const filePath of await listDirectoryFiles(dockerContextDirectory)) {
		// oxlint-disable-next-line no-await-in-loop -- hash order is deterministic and low-volume for e2e Docker contexts.
		await hashFileInto(hasher, filePath, dockerContextDirectory);
	}
	return hasher.digest('hex');
}

async function readTextIfPresent(filePath: string | undefined): Promise<string | undefined> {
	if (filePath === undefined || !(await pathExists(filePath))) {
		return undefined;
	}
	return await fs.readFile(filePath, 'utf8');
}

async function normalizeE2eImageSourceForFingerprint(source: unknown): Promise<unknown> {
	if (!isObjectRecord(source)) {
		return source;
	}
	const overlay = source.overlay;
	return {
		...source,
		...(typeof overlay === 'string'
			? { overlay: { content: await readTextIfPresent(overlay) } }
			: {}),
	};
}

async function computeE2eImageRecipeFingerprint(options: {
	readonly buildConfigPath: string;
	readonly dockerfile?: string;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	readonly source?: unknown;
}): Promise<string> {
	const hasher = crypto.createHash('sha256');
	hasher.update(
		JSON.stringify({
			buildConfig: await readTextIfPresent(options.buildConfigPath),
			dockerContext:
				options.dockerfile === undefined
					? undefined
					: await computeDockerContextFingerprint(options.dockerfile),
			effectiveBuildFingerprint: await computeFingerprintFromConfigPath(
				options.buildConfigPath,
				options.managedGatewayBoot === undefined
					? {}
					: { managedGatewayBoot: options.managedGatewayBoot },
			),
			managedGatewayBoot: options.managedGatewayBoot,
			source: await normalizeE2eImageSourceForFingerprint(options.source),
		}),
	);
	return hasher.digest('hex');
}

function managedGatewayBootProjectionForE2eTarget(
	family: E2eImageTarget['family'],
	profile:
		| LoadedSystemConfig['imageProfiles']['gateways'][string]
		| LoadedSystemConfig['imageProfiles']['toolVms'][string],
): ManagedGatewayImageBootProjection | undefined {
	if (family !== 'gateway' || (profile.type !== 'openclaw' && profile.type !== 'hermes')) {
		return undefined;
	}
	return {
		frameworkBootEntry:
			profile.type === 'hermes' ? 'hermes-framework-service' : 'openclaw-framework-service',
		kind: 'managed-gateway-exact-two-role',
	};
}

function managedGatewayBootProjectionsEqual(
	left: ManagedGatewayImageBootProjection | undefined,
	right: ManagedGatewayImageBootProjection | undefined,
): boolean {
	return left?.kind === right?.kind && left?.frameworkBootEntry === right?.frameworkBootEntry;
}

async function collectE2eImageTargets(
	project: GatewayE2eImageProject,
	imageFamilies: readonly E2eImageTarget['family'][] = ['gateway', 'toolVm'],
): Promise<readonly E2eImageTarget[]> {
	const selectedFamilies = new Set(imageFamilies);
	const createImageTarget = async (
		family: 'gateway' | 'toolVm',
		profileName: string,
		profile:
			| LoadedSystemConfig['imageProfiles']['gateways'][string]
			| LoadedSystemConfig['imageProfiles']['toolVms'][string],
	): Promise<E2eImageTarget> => {
		const managedGatewayBoot = managedGatewayBootProjectionForE2eTarget(family, profile);
		const target: E2eImageTarget = {
			buildConfigPath: profile.buildConfig,
			cacheDirectory: path.join(
				project.systemConfig.cacheDir,
				family === 'gateway' ? 'gateway-images' : 'tool-vm-images',
				profileName,
			),
			e2eManifestEligible:
				profile.source === undefined ||
				(family === 'gateway' && selectedFamilies.size === 1 && selectedFamilies.has('gateway')),
			family,
			...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
			name: profileName,
			recipeFingerprint: await computeE2eImageRecipeFingerprint({
				buildConfigPath: profile.buildConfig,
				...(profile.dockerfile === undefined ? {} : { dockerfile: profile.dockerfile }),
				...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
				...(profile.source === undefined ? {} : { source: profile.source }),
			}),
		};
		if (profile.dockerfile !== undefined) {
			return { ...target, dockerfile: profile.dockerfile };
		}
		if (profile.source !== undefined) {
			return { ...target, source: profile.source };
		}
		return target;
	};
	const gatewayTargets = selectedFamilies.has('gateway')
		? await Promise.all(
				Object.entries(project.systemConfig.imageProfiles.gateways).map(
					async ([profileName, profile]) =>
						await createImageTarget('gateway', profileName, profile),
				),
			)
		: [];
	const toolVmTargets = selectedFamilies.has('toolVm')
		? await Promise.all(
				Object.entries(project.systemConfig.imageProfiles.toolVms).map(
					async ([profileName, profile]) => await createImageTarget('toolVm', profileName, profile),
				),
			)
		: [];
	return [...gatewayTargets, ...toolVmTargets];
}

function e2ePreparedImageManifestPath(cacheDir: string): string {
	return path.join(cacheDir, e2ePreparedImageManifestFileName);
}

function parseE2ePreparedImageManifest(value: unknown): E2ePreparedImageManifest {
	if (!isObjectRecord(value) || value.schemaVersion !== e2ePreparedImageManifestSchemaVersion) {
		return { entries: [], schemaVersion: e2ePreparedImageManifestSchemaVersion };
	}
	if (!Array.isArray(value.entries)) {
		return { entries: [], schemaVersion: e2ePreparedImageManifestSchemaVersion };
	}
	const entries = value.entries.filter((entry): entry is E2ePreparedImageManifestEntry => {
		if (!isObjectRecord(entry)) {
			return false;
		}
		const managedGatewayBoot = entry.managedGatewayBoot;
		const hasValidManagedGatewayBoot =
			managedGatewayBoot === undefined ||
			(isObjectRecord(managedGatewayBoot) &&
				managedGatewayBoot.kind === 'managed-gateway-exact-two-role' &&
				(managedGatewayBoot.frameworkBootEntry === 'openclaw-framework-service' ||
					managedGatewayBoot.frameworkBootEntry === 'hermes-framework-service') &&
				Object.keys(managedGatewayBoot).length === 2);
		return (
			(entry.family === 'gateway' || entry.family === 'toolVm') &&
			typeof entry.name === 'string' &&
			typeof entry.recipeFingerprint === 'string' &&
			typeof entry.buildConfigPath === 'string' &&
			typeof entry.cacheDirectory === 'string' &&
			typeof entry.fingerprint === 'string' &&
			typeof entry.imagePath === 'string' &&
			hasValidManagedGatewayBoot
		);
	});
	return { entries, schemaVersion: e2ePreparedImageManifestSchemaVersion };
}

async function readE2ePreparedImageManifest(cacheDir: string): Promise<E2ePreparedImageManifest> {
	try {
		const parsed = JSON.parse(
			await fs.readFile(e2ePreparedImageManifestPath(cacheDir), 'utf8'),
		) as unknown;
		return parseE2ePreparedImageManifest(parsed);
	} catch (error) {
		if (error instanceof SyntaxError) {
			return { entries: [], schemaVersion: e2ePreparedImageManifestSchemaVersion };
		}
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return { entries: [], schemaVersion: e2ePreparedImageManifestSchemaVersion };
		}
		throw error;
	}
}

async function writeE2ePreparedImageManifest(
	cacheDir: string,
	manifest: E2ePreparedImageManifest,
): Promise<void> {
	await fs.mkdir(cacheDir, { recursive: true });
	await fs.writeFile(
		e2ePreparedImageManifestPath(cacheDir),
		`${JSON.stringify(manifest, null, '\t')}\n`,
		'utf8',
	);
}

function e2eImageTargetKey(target: E2eImageTarget): string {
	return `${target.family}:${target.name}:${target.recipeFingerprint}`;
}

function e2eManifestEntryKey(entry: E2ePreparedImageManifestEntry): string {
	return `${entry.family}:${entry.name}:${entry.recipeFingerprint}`;
}

async function materializePreparedE2eImagesFromManifest(
	project: GatewayE2eImageProject,
	targets: readonly E2eImageTarget[],
): Promise<boolean> {
	if (targets.some((target) => !target.e2eManifestEligible)) {
		return false;
	}
	const manifest = await readE2ePreparedImageManifest(project.systemConfig.cacheDir);
	const entriesByKey = new Map(
		manifest.entries.map((entry) => [e2eManifestEntryKey(entry), entry] as const),
	);
	const targetReadiness = await Promise.all(
		targets.map(async (target) => {
			const entry = entriesByKey.get(e2eImageTargetKey(target));
			return (
				entry !== undefined &&
				managedGatewayBootProjectionsEqual(entry.managedGatewayBoot, target.managedGatewayBoot) &&
				(await hasManagedVmImageAssets(entry.imagePath))
			);
		}),
	);
	if (targetReadiness.some((isReady) => !isReady)) {
		return false;
	}
	await Promise.all(
		targets.map(async (target) => {
			const entry = entriesByKey.get(e2eImageTargetKey(target));
			if (entry === undefined) {
				throw new Error(
					`Missing prepared e2e image manifest entry for ${target.family}/${target.name}.`,
				);
			}
			await writePreparedManagedVmImage({
				buildConfigPath: target.buildConfigPath,
				cacheDir: target.cacheDirectory,
				fingerprint: entry.fingerprint,
				...(entry.fingerprintInput === undefined
					? {}
					: { fingerprintInput: entry.fingerprintInput }),
				imagePath: entry.imagePath,
				...(entry.managedGatewayBoot === undefined
					? {}
					: { managedGatewayBoot: entry.managedGatewayBoot }),
			});
		}),
	);
	return true;
}

async function recordPreparedE2eImages(
	project: GatewayE2eImageProject,
	targets: readonly E2eImageTarget[],
): Promise<void> {
	const manifest = await readE2ePreparedImageManifest(project.systemConfig.cacheDir);
	const entriesByKey = new Map(
		manifest.entries.map((entry) => [e2eManifestEntryKey(entry), entry] as const),
	);
	const preparedImages = await Promise.all(
		targets.map(async (target) => {
			if (!target.e2eManifestEligible) {
				return null;
			}
			const preparedImage: PreparedManagedVmImage | undefined = await readPreparedManagedVmImage({
				buildConfigPath: target.buildConfigPath,
				cacheDir: target.cacheDirectory,
			});
			return { preparedImage, target };
		}),
	);
	for (const item of preparedImages) {
		if (item === null || item.preparedImage === undefined) {
			continue;
		}
		const { preparedImage, target } = item;
		if (
			!managedGatewayBootProjectionsEqual(
				preparedImage.managedGatewayBoot,
				target.managedGatewayBoot,
			)
		) {
			throw new Error(
				`Prepared e2e image boot projection does not match ${target.family}/${target.name}.`,
			);
		}
		entriesByKey.set(e2eImageTargetKey(target), {
			buildConfigPath: path.resolve(target.buildConfigPath),
			cacheDirectory: path.resolve(target.cacheDirectory),
			family: target.family,
			fingerprint: preparedImage.fingerprint,
			...(preparedImage.fingerprintInput === undefined
				? {}
				: { fingerprintInput: preparedImage.fingerprintInput }),
			imagePath: preparedImage.imagePath,
			...(preparedImage.managedGatewayBoot === undefined
				? {}
				: { managedGatewayBoot: preparedImage.managedGatewayBoot }),
			name: target.name,
			recipeFingerprint: target.recipeFingerprint,
		});
	}
	await writeE2ePreparedImageManifest(project.systemConfig.cacheDir, {
		entries: [...entriesByKey.values()].toSorted((leftEntry, rightEntry) =>
			e2eManifestEntryKey(leftEntry).localeCompare(e2eManifestEntryKey(rightEntry)),
		),
		schemaVersion: e2ePreparedImageManifestSchemaVersion,
	});
}

export async function findReusableGatewayImageDirectory(options: {
	readonly currentProjectRoot: string;
	readonly gatewayBuildConfigPath: string;
	readonly imageProfileName?: string;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
}): Promise<string | null> {
	const imageProfileName = options.imageProfileName ?? 'worker';
	const explicitE2eCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
	if (!explicitE2eCacheRoot) {
		return null;
	}
	const requiredFingerprint = await computeFingerprintFromConfigPath(
		options.gatewayBuildConfigPath,
		options.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.managedGatewayBoot },
	);
	if (!(await pathExists(explicitE2eCacheRoot))) {
		return null;
	}
	const tempRootEntries = await fs.readdir(explicitE2eCacheRoot, { withFileTypes: true });
	const e2eRunDirectories = tempRootEntries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(explicitE2eCacheRoot, entry.name));

	for (const e2eRunDirectory of e2eRunDirectories) {
		if (e2eRunDirectory === options.currentProjectRoot) {
			continue;
		}
		const candidateImageDirectories = [
			path.join(e2eRunDirectory, 'gateway-images', imageProfileName, requiredFingerprint),
			path.join(e2eRunDirectory, 'cache', 'gateway-images', imageProfileName, requiredFingerprint),
		];
		for (const candidateImageDir of candidateImageDirectories) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- intentionally searches cache candidates
			if (await hasManagedVmImageAssets(candidateImageDir)) {
				return candidateImageDir;
			}
		}
	}

	return null;
}

export async function seedGatewayImageCacheIfAvailable(options: {
	readonly activeCacheDir: string;
	readonly currentProjectRoot: string;
	readonly gatewayBuildConfigPath: string;
	readonly imageProfileName?: string;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
}): Promise<void> {
	const imageProfileName = options.imageProfileName ?? 'worker';
	const reusableImageDir = await findReusableGatewayImageDirectory({
		currentProjectRoot: options.currentProjectRoot,
		gatewayBuildConfigPath: options.gatewayBuildConfigPath,
		imageProfileName,
		...(options.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.managedGatewayBoot }),
	});
	if (!reusableImageDir) {
		return;
	}

	const requiredFingerprint = await computeFingerprintFromConfigPath(
		options.gatewayBuildConfigPath,
		options.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.managedGatewayBoot },
	);
	const activeImageDir = path.join(
		options.activeCacheDir,
		'gateway-images',
		imageProfileName,
		requiredFingerprint,
	);
	if (activeImageDir === reusableImageDir) {
		return;
	}

	await fs.rm(activeImageDir, { recursive: true, force: true });
	await fs.mkdir(path.dirname(activeImageDir), { recursive: true });
	await fs.symlink(reusableImageDir, activeImageDir, 'dir');
}

export async function prepareGatewayE2eProjectImages(
	options: PrepareGatewayE2eProjectImagesOptions,
): Promise<void> {
	const imageFamilies = options.imageFamilies ?? ['gateway', 'toolVm'];
	if (
		imageFamilies.includes('toolVm') &&
		process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES === '1'
	) {
		const managedToolVmProfileNames = Object.entries(
			options.project.systemConfig.imageProfiles.toolVms,
		)
			.filter(([, profile]) => profile.source !== undefined)
			.map(([profileName]) => profileName);
		if (managedToolVmProfileNames.length > 0) {
			await useLocalToolVmMcpPortalPackage({
				profileNames: managedToolVmProfileNames,
				projectRoot: options.project.tempRoot,
				repoRoot: process.cwd(),
				systemConfig: options.project.systemConfig,
			});
		}
	}
	const imageTargets = await collectE2eImageTargets(options.project, imageFamilies);
	if (imageTargets.length === 0) {
		if (process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE === '1') {
			throw new Error('strict prepared e2e image cache required; no selected image targets.');
		}
		return;
	}
	if (await materializePreparedE2eImagesFromManifest(options.project, imageTargets)) {
		return;
	}
	if (process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE === '1') {
		const targetSummary = imageTargets
			.map(
				(target) =>
					`${target.family}/${target.name}#${target.recipeFingerprint}${
						target.e2eManifestEligible ? '' : ' (not manifest-eligible)'
					}`,
			)
			.join(', ');
		throw new Error(
			`strict prepared e2e image cache required; unable to materialize ${targetSummary || 'no selected image targets'}.`,
		);
	}
	await Promise.all(
		Object.entries(options.project.systemConfig.imageProfiles.gateways).map(
			async ([profileName, gatewayProfile]) => {
				const managedGatewayBoot = managedGatewayBootProjectionForE2eTarget(
					'gateway',
					gatewayProfile,
				);
				await seedGatewayImageCacheIfAvailable({
					activeCacheDir: options.project.systemConfig.cacheDir,
					currentProjectRoot: options.project.tempRoot,
					gatewayBuildConfigPath: gatewayProfile.buildConfig,
					imageProfileName: profileName,
					...(managedGatewayBoot === undefined ? {} : { managedGatewayBoot }),
				});
			},
		),
	);
	const runBuild = options.runBuild ?? runBuildCommand;
	await runBuild({ systemConfig: options.project.systemConfig });
	await recordPreparedE2eImages(options.project, imageTargets);
}

export function createSmokeSecretResolver(secrets: E2eHarnessSecretMap): SecretResolver {
	const resolve = async (ref: SecretRef): Promise<string> => {
		if (ref.source === 'config') {
			return ref.value;
		}
		const secretKey = ref.ref;
		const secret = secrets[secretKey] ?? process.env[secretKey];
		if (secret === undefined) {
			throw new Error(`Smoke secret '${secretKey}' is not configured.`);
		}
		return secret;
	};
	return {
		resolve,
		resolveAll: async (refs: Record<string, SecretRef>) => {
			const resolvedSecrets: Record<string, string> = {};
			for (const [secretName, ref] of Object.entries(refs)) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- keeps deterministic secret errors
				resolvedSecrets[secretName] = await resolve(ref);
			}
			return resolvedSecrets;
		},
	};
}

function applySmokeEnvironment(secrets: E2eHarnessSecretMap): () => void {
	const previousValues = new Map<string, string | undefined>();
	for (const [secretName, secretValue] of Object.entries(secrets)) {
		previousValues.set(secretName, process.env[secretName]);
		process.env[secretName] = secretValue;
	}
	return () => {
		for (const [secretName, previousValue] of previousValues) {
			if (previousValue === undefined) {
				delete process.env[secretName];
			} else {
				process.env[secretName] = previousValue;
			}
		}
	};
}

export function getOpenClawE2eZone(systemConfig: LoadedSystemConfig): OpenClawE2eProject['zone'] {
	const zone = systemConfig.zones[0];
	if (!zone || zone.gateway.type !== 'openclaw') {
		throw new Error('Expected smoke system config to contain an OpenClaw zone.');
	}
	return { ...zone, gateway: zone.gateway };
}

function getWorkerE2eZone(systemConfig: LoadedSystemConfig): WorkerE2eProject['zone'] {
	const zone = systemConfig.zones[0];
	if (!zone || zone.gateway.type !== 'worker') {
		throw new Error('Expected smoke system config to contain a Worker Gateway zone.');
	}
	return { ...zone, gateway: zone.gateway };
}

function packageFileEntryIsLiteral(fileEntry: string): boolean {
	return !/[!*[\]{}]/u.test(fileEntry);
}

async function assertLocalPackageFilesExist(props: LocalNpmPackageTarball): Promise<void> {
	const packageJsonPath = path.join(props.packageDirectory, 'package.json');
	const packageManifest = mutableJsonRecord(await loadJsonConfigFile(packageJsonPath));
	const files = packageManifest?.files;
	const fileEntries = Array.isArray(files)
		? files.filter((fileEntry): fileEntry is string => typeof fileEntry === 'string')
		: undefined;
	if (fileEntries === undefined) {
		return;
	}
	await Promise.all(
		fileEntries.filter(packageFileEntryIsLiteral).map(async (fileEntry) => {
			try {
				await fs.access(path.join(props.packageDirectory, fileEntry));
			} catch (error) {
				if (isJsonRecord(error) && error.code === 'ENOENT') {
					throw new Error(
						`${props.packageName} declares package file "${fileEntry}" but it does not exist.`,
						{ cause: error },
					);
				}
				throw error;
			}
		}),
	);
}

export function resolveLocalPackagePackArgs(packDirectory: string): readonly string[] {
	return ['pack', '--pack-destination', packDirectory, '--config.ignore-scripts=true'];
}

function parseLocalPackagePackPlan(value: unknown, packageName: string): LocalPackagePackPlan {
	if (!isJsonRecord(value)) {
		throw new Error(`Expected pnpm pack dry-run for ${packageName} to return an object.`);
	}
	const files = Array.isArray(value.files)
		? value.files.filter((file): file is LocalPackagePackPlanFile => {
				return isJsonRecord(file) && typeof file.path === 'string' && file.path.length > 0;
			})
		: [];
	if (
		typeof value.name !== 'string' ||
		typeof value.version !== 'string' ||
		typeof value.filename !== 'string' ||
		files.length === 0
	) {
		throw new Error(`Unexpected pnpm pack dry-run result for ${packageName}.`);
	}
	return {
		filename: value.filename,
		files,
		name: value.name,
		version: value.version,
	};
}

function resolveLocalPackagePackPlan(
	packageDirectory: string,
	packageName: string,
): LocalPackagePackPlan {
	const dryRunOutput = execFileSync(
		'pnpm',
		['pack', '--dry-run', '--json', '--config.ignore-scripts=true'],
		{
			cwd: packageDirectory,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	return parseLocalPackagePackPlan(JSON.parse(dryRunOutput) as unknown, packageName);
}

function cacheSafeLocalPackageName(packageName: string): string {
	return packageName.replace(/^@/u, '').replaceAll('/', '__');
}

async function computeLocalPackagePackFingerprint(
	packageDirectory: string,
	packPlan: LocalPackagePackPlan,
): Promise<string> {
	const hash = crypto.createHash('sha256');
	hash.update(`${packPlan.name}\0${packPlan.version}\0${packPlan.filename}\0`);
	for (const file of packPlan.files.toSorted((left, right) =>
		left.path.localeCompare(right.path),
	)) {
		const filePath = path.join(packageDirectory, file.path);
		// oxlint-disable-next-line no-await-in-loop -- ordered hashing keeps cache keys deterministic
		const fileContents = await fs.readFile(filePath);
		hash.update(`${file.path}\0`);
		hash.update(fileContents);
		hash.update('\0');
	}
	return hash.digest('hex').slice(0, 24);
}

async function packLocalPackageTarball(props: LocalNpmPackageTarball): Promise<string> {
	const packageJsonPath = path.join(props.packageDirectory, 'package.json');
	await fs.access(packageJsonPath);
	await assertLocalPackageFilesExist(props);
	const packPlan = resolveLocalPackagePackPlan(props.packageDirectory, props.packageName);
	const packFingerprint = await computeLocalPackagePackFingerprint(
		props.packageDirectory,
		packPlan,
	);
	const cachedPackageDirectory = path.join(
		resolveE2eCacheRoot(),
		'local-package-tarballs',
		cacheSafeLocalPackageName(props.packageName),
		packFingerprint,
	);
	const cachedTarballPath = path.join(cachedPackageDirectory, packPlan.filename);
	try {
		await fs.access(cachedTarballPath);
		return cachedTarballPath;
	} catch (error) {
		if (!isJsonRecord(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}
	const packDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `${props.packageName}-pack-`));
	try {
		execFileSync('pnpm', [...resolveLocalPackagePackArgs(packDirectory)], {
			cwd: props.packageDirectory,
			stdio: 'pipe',
		});
		const packedTarballPath = path.join(packDirectory, packPlan.filename);
		await fs.access(packedTarballPath);
		await fs.mkdir(cachedPackageDirectory, { recursive: true });
		const temporaryCachedTarballPath = path.join(
			cachedPackageDirectory,
			`${packPlan.filename}.${process.pid}.${crypto.randomUUID()}.tmp`,
		);
		await fs.copyFile(packedTarballPath, temporaryCachedTarballPath);
		await fs.rename(temporaryCachedTarballPath, cachedTarballPath).catch(async (error) => {
			await fs.rm(temporaryCachedTarballPath, { force: true });
			if (isJsonRecord(error) && error.code === 'EEXIST') {
				return;
			}
			throw error;
		});
		return cachedTarballPath;
	} catch (error) {
		await fs.rm(packDirectory, { force: true, recursive: true });
		throw error;
	} finally {
		await fs.rm(packDirectory, { force: true, recursive: true });
	}
}

function isOwnedLocalPackagePackDirectory(packDirectory: string): boolean {
	const resolvedPackDirectory = path.resolve(packDirectory);
	const resolvedSystemTempRoot = path.resolve(os.tmpdir());
	if (
		resolvedPackDirectory === resolvedSystemTempRoot ||
		!resolvedPackDirectory.startsWith(`${resolvedSystemTempRoot}${path.sep}`)
	) {
		return false;
	}
	return path.basename(resolvedPackDirectory).includes('-pack-');
}

export async function removeE2eLocalPackageTarballs(
	tarballPaths: readonly (string | undefined)[],
): Promise<void> {
	await Promise.all(
		Array.from(
			new Set(
				tarballPaths
					.filter((tarballPath): tarballPath is string => tarballPath !== undefined)
					.map((tarballPath) => path.dirname(tarballPath)),
			),
		)
			.filter(isOwnedLocalPackagePackDirectory)
			.map(async (packDirectory) => {
				await fs.rm(packDirectory, { force: true, recursive: true });
			}),
	);
}

export async function copyLocalPackageTarballsToDockerContext(options: {
	readonly dockerContextDirectory: string;
	readonly tarballs: readonly LocalDockerPackageTarball[];
}): Promise<void> {
	await Promise.all(
		options.tarballs.map(async (tarball) => {
			const targetPath = path.join(options.dockerContextDirectory, tarball.archiveName);
			await fs.copyFile(tarball.sourcePath, targetPath);
			await fs.utimes(
				targetPath,
				dockerContextLocalPackageTimestamp,
				dockerContextLocalPackageTimestamp,
			);
		}),
	);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createLocalDockerPackageTarball(props: {
	readonly packageName: string;
	readonly sourcePath: string;
}): LocalDockerPackageTarball {
	return {
		archiveName: path.basename(props.sourcePath),
		packageName: props.packageName,
		sourcePath: props.sourcePath,
	};
}

export async function packLocalAgentVmPackageTarball(options: {
	readonly packageName: string;
	readonly repoRoot: string;
}): Promise<string> {
	return await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', options.packageName),
		packageName: options.packageName,
	});
}

export function localDockerPackageDependencyName(tarball: LocalDockerPackageTarball): string {
	return `@agent-vm/${tarball.packageName}`;
}

function renderLocalDockerPackageManifest(tarballs: readonly LocalDockerPackageTarball[]): string {
	const dependencies = Object.fromEntries(
		tarballs.map((tarball) => [
			localDockerPackageDependencyName(tarball),
			`file:/tmp/${tarball.archiveName}`,
		]),
	);
	return `${JSON.stringify(
		{
			private: true,
			dependencies,
			pnpm: {
				overrides: dependencies,
			},
		},
		null,
		2,
	)}\n`;
}

export async function buildLocalPythonWheel(options: {
	readonly distributionFilePrefix: string;
	readonly outputDirectory: string;
	readonly packageDirectory: string;
	readonly repoRoot: string;
}): Promise<string> {
	await execFileAsync(
		'uv',
		['build', '--wheel', '--out-dir', options.outputDirectory, options.packageDirectory],
		{ cwd: options.repoRoot, maxBuffer: 20 * 1024 * 1024 },
	);
	const matchingWheelFileNames = (await fs.readdir(options.outputDirectory)).filter(
		(fileName) => fileName.startsWith(options.distributionFilePrefix) && fileName.endsWith('.whl'),
	);
	if (matchingWheelFileNames.length !== 1) {
		throw new Error(
			`Expected one ${options.distributionFilePrefix} wheel, found ${String(matchingWheelFileNames.length)}.`,
		);
	}
	const matchingWheelFileName = matchingWheelFileNames[0];
	if (matchingWheelFileName === undefined) {
		throw new Error(`Expected one ${options.distributionFilePrefix} wheel.`);
	}
	return path.join(options.outputDirectory, matchingWheelFileName);
}

export function requireLocalPackageTarballPath(
	packedTarballs: readonly { readonly packageName: string; readonly sourcePath: string }[],
	packageName: string,
): string {
	const packedTarball = packedTarballs.find((entry) => entry.packageName === packageName);
	if (packedTarball === undefined) {
		throw new Error(`Required local package tarball '${packageName}' was not packed.`);
	}
	return packedTarball.sourcePath;
}

function renderLocalDockerPackageInstallLines(
	tarballs: readonly LocalDockerPackageTarball[],
): readonly string[] {
	const manifestWriterScript = [
		'require("node:fs/promises").writeFile(',
		'"/opt/agent-vm/local-packages/package.json",',
		JSON.stringify(renderLocalDockerPackageManifest(tarballs)),
		').catch((error) => { console.error(error); process.exitCode = 1; })',
	].join('');
	return [
		'RUN mkdir -p /opt/agent-vm/local-packages && \\',
		`    node -e ${shellSingleQuote(manifestWriterScript)} && \\`,
		'    cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts && \\',
		'    rm -f ' + tarballs.map((tarball) => `/tmp/${tarball.archiveName}`).join(' '),
	];
}

function renderLocalDockerPackageInstallCommand(
	tarballs: readonly LocalDockerPackageTarball[],
): string {
	const [runLine, ...continuationLines] = renderLocalDockerPackageInstallLines(tarballs);
	if (runLine === undefined || !runLine.startsWith('RUN ')) {
		throw new Error(
			'Expected the local package install renderer to begin with a Dockerfile RUN command.',
		);
	}
	return [runLine.slice('RUN '.length), ...continuationLines].join('\n');
}

function isLocalToolVmPackageInstallCommand(command: string): boolean {
	return (
		command.includes('/opt/agent-vm/local-packages/package.json') &&
		command.includes('file:/tmp/agent-vm-mcp-portal-')
	);
}

function resolveManagedOverlayCopySourcePath(
	overlayDirectory: string,
	relativeSourcePath: string,
): string {
	if (path.isAbsolute(relativeSourcePath) || relativeSourcePath.split(/[\\/]+/u).includes('..')) {
		throw new Error(
			`Managed image overlay copy source '${relativeSourcePath}' must be relative and must not contain parent traversal.`,
		);
	}
	return path.join(overlayDirectory, relativeSourcePath);
}

async function writeLocalToolVmManagedOverlay(options: {
	readonly localPackageTarballs: readonly LocalDockerPackageTarball[];
	readonly originalOverlayPath: string | undefined;
	readonly overlayDirectory: string;
}): Promise<string> {
	const originalOverlay = await loadManagedImageOverlay(options.originalOverlayPath);
	const originalOverlayDirectory =
		options.originalOverlayPath === undefined
			? undefined
			: path.dirname(options.originalOverlayPath);
	const generatedCopySourcePaths = new Set(
		options.localPackageTarballs.map((tarball) => `local-agent-vm/${tarball.archiveName}`),
	);
	const preservedCopyEntries = originalOverlay.copy.filter(
		(copyEntry) => !generatedCopySourcePaths.has(copyEntry.from),
	);
	await fs.mkdir(options.overlayDirectory, { recursive: true });
	await Promise.all(
		preservedCopyEntries.map(async (copyEntry): Promise<void> => {
			if (originalOverlayDirectory === undefined) {
				throw new Error('Managed Tool VM overlay copy entries require an original overlay path.');
			}
			const sourcePath = resolveManagedOverlayCopySourcePath(
				originalOverlayDirectory,
				copyEntry.from,
			);
			const targetPath = resolveManagedOverlayCopySourcePath(
				options.overlayDirectory,
				copyEntry.from,
			);
			if (path.resolve(sourcePath) === path.resolve(targetPath)) {
				return;
			}
			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.copyFile(sourcePath, targetPath);
		}),
	);
	const localPackageDirectory = path.join(options.overlayDirectory, 'local-agent-vm');
	await fs.mkdir(localPackageDirectory, { recursive: true });
	await Promise.all(
		options.localPackageTarballs.map(async (tarball): Promise<void> => {
			await fs.copyFile(tarball.sourcePath, path.join(localPackageDirectory, tarball.archiveName));
		}),
	);
	const derivedOverlay = {
		...originalOverlay,
		copy: [
			...preservedCopyEntries,
			...options.localPackageTarballs.map((tarball) => ({
				from: `local-agent-vm/${tarball.archiveName}`,
				to: `/tmp/${tarball.archiveName}`,
			})),
		],
		runAfterBase: [
			...originalOverlay.runAfterBase.filter(
				(command) => !isLocalToolVmPackageInstallCommand(command),
			),
			renderLocalDockerPackageInstallCommand(options.localPackageTarballs),
		],
	} satisfies ManagedImageOverlay;
	const derivedOverlayPath = path.join(options.overlayDirectory, 'overlay.jsonc');
	await fs.writeFile(derivedOverlayPath, `${JSON.stringify(derivedOverlay, null, '\t')}\n`, 'utf8');
	return derivedOverlayPath;
}

export async function useLocalToolVmMcpPortalPackageTarballs(options: {
	readonly localAgentPortalSdkTarballPath: string;
	readonly localConfigContractsTarballPath: string;
	readonly localMcpPortalTarballPath: string;
	readonly localSecretManagementTarballPath: string;
	readonly profileNames?: readonly string[] | undefined;
	readonly projectRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const managedImageRelease = await resolveManagedImageRelease();
	const baseImage = managedImageRelease.baseImages['tool-vm'];
	const toolVmProfiles = Object.entries(options.systemConfig.imageProfiles.toolVms);
	const localPackageTarballs = [
		createLocalDockerPackageTarball({
			packageName: 'agent-portal-sdk',
			sourcePath: options.localAgentPortalSdkTarballPath,
		}),
		createLocalDockerPackageTarball({
			packageName: 'config-contracts',
			sourcePath: options.localConfigContractsTarballPath,
		}),
		createLocalDockerPackageTarball({
			packageName: 'secret-management',
			sourcePath: options.localSecretManagementTarballPath,
		}),
		createLocalDockerPackageTarball({
			packageName: 'mcp-portal',
			sourcePath: options.localMcpPortalTarballPath,
		}),
	] satisfies readonly LocalDockerPackageTarball[];
	await Promise.all(
		toolVmProfiles
			.filter(
				([profileName]) =>
					options.profileNames === undefined || options.profileNames.includes(profileName),
			)
			.map(async ([profileName, toolVmProfile]): Promise<void> => {
				if (toolVmProfile.source !== undefined) {
					const overlayDirectory = path.join(
						options.projectRoot,
						'vm-images',
						'tool-vms',
						`${profileName}-local-mcp-portal-overlay`,
					);
					const derivedOverlayPath = await writeLocalToolVmManagedOverlay({
						localPackageTarballs,
						originalOverlayPath: toolVmProfile.source.overlay,
						overlayDirectory,
					});
					toolVmProfile.source = {
						...toolVmProfile.source,
						overlay: derivedOverlayPath,
					};
					return;
				}
				const dockerContextDirectory = path.join(
					options.projectRoot,
					'vm-images',
					'tool-vms',
					`${profileName}-local-mcp-portal`,
				);
				const dockerfilePath = path.join(dockerContextDirectory, 'Dockerfile');
				await fs.rm(dockerContextDirectory, { force: true, recursive: true });
				await fs.mkdir(dockerContextDirectory, { recursive: true });
				await copyLocalPackageTarballsToDockerContext({
					dockerContextDirectory,
					tarballs: localPackageTarballs,
				});
				await fs.writeFile(
					dockerfilePath,
					[
						`FROM ${baseImage.repository}:${baseImage.tag}`,
						'',
						'# Generated by the OpenClaw smoke harness from the local MCP Portal package.',
						...localPackageTarballs.map(
							(tarball) => `COPY ${tarball.archiveName} /tmp/${tarball.archiveName}`,
						),
						...renderLocalDockerPackageInstallLines(localPackageTarballs),
						'',
					].join('\n'),
					'utf8',
				);
				toolVmProfile.dockerfile = dockerfilePath;
				delete toolVmProfile.source;
			}),
	);
}

export async function useLocalToolVmMcpPortalPackage(options: {
	readonly profileNames?: readonly string[] | undefined;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const localAgentPortalSdkTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'agent-portal-sdk',
		repoRoot: options.repoRoot,
	});
	const localConfigContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'config-contracts',
		repoRoot: options.repoRoot,
	});
	const localSecretManagementTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'secret-management',
		repoRoot: options.repoRoot,
	});
	const localMcpPortalTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'mcp-portal',
		repoRoot: options.repoRoot,
	});
	try {
		await useLocalToolVmMcpPortalPackageTarballs({
			localAgentPortalSdkTarballPath,
			localConfigContractsTarballPath,
			localMcpPortalTarballPath,
			localSecretManagementTarballPath,
			...(options.profileNames === undefined ? {} : { profileNames: options.profileNames }),
			projectRoot: options.projectRoot,
			systemConfig: options.systemConfig,
		});
	} finally {
		await removeE2eLocalPackageTarballs([
			localAgentPortalSdkTarballPath,
			localConfigContractsTarballPath,
			localSecretManagementTarballPath,
			localMcpPortalTarballPath,
		]);
	}
}

async function writeManagedOpenClawE2eDockerfileBase(options: {
	readonly dockerContextDirectory: string;
	readonly openClawAgentVmPackageInstallMode?: 'managed-packages' | 'local-overlay' | undefined;
	readonly profileName: string;
}): Promise<string> {
	const managedImageRelease = await resolveManagedImageRelease();
	const result = await generateManagedDockerfile({
		base: 'openclaw-gateway',
		imageTargetFamily: 'gateway',
		imageTargetName: options.profileName,
		managedImageRelease,
		openClawAgentVmPackageInstallMode: options.openClawAgentVmPackageInstallMode,
		outputDirectory: options.dockerContextDirectory,
		requiredOpenClawPackageNames: ['@openclaw/discord'],
	});
	return result.dockerfilePath;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mutableJsonRecord(value: unknown): Record<string, unknown> | undefined {
	if (!isJsonRecord(value)) {
		return undefined;
	}
	return value;
}

async function runDockerCommand(args: readonly string[]): Promise<void> {
	await execFileAsync('docker', [...args]);
}

async function readE2eDockerImageTag(buildConfigPath: string): Promise<string | null> {
	let buildConfig: Record<string, unknown> | undefined;
	try {
		buildConfig = mutableJsonRecord(await loadJsonConfigFile(buildConfigPath));
	} catch (error) {
		if (isJsonRecord(error) && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
	const ociConfig = mutableJsonRecord(buildConfig?.oci);
	const imageTag = ociConfig?.image;
	return typeof imageTag === 'string' && imageTag.length > 0 ? imageTag : null;
}

export async function collectE2eDockerImageTags(
	systemConfig: LoadedSystemConfig,
): Promise<readonly string[]> {
	const imageProfiles = [
		...Object.values(systemConfig.imageProfiles.gateways),
		...Object.values(systemConfig.imageProfiles.toolVms),
	];
	const imageTags: string[] = [];
	for (const imageProfile of imageProfiles) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- config files are intentionally read deterministically
		const imageTag = await readE2eDockerImageTag(imageProfile.buildConfig);
		if (imageTag !== null) {
			imageTags.push(imageTag);
		}
	}
	return Array.from(new Set(imageTags));
}

export async function removeE2eDockerImages(
	imageTags: readonly string[],
	options: RemoveE2eDockerImagesOptions = {},
): Promise<void> {
	const dockerCommand = options.runDockerCommand ?? runDockerCommand;
	for (const imageTag of Array.from(new Set(imageTags))) {
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop -- one tag at a time keeps cleanup errors attributable
			await dockerCommand(['image', 'inspect', imageTag]);
		} catch {
			continue;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- one tag at a time keeps cleanup errors attributable
		await dockerCommand(['image', 'rm', '--force', imageTag]);
	}
}

export async function removeE2eDockerImagesForSystemConfig(
	systemConfig: LoadedSystemConfig,
	options: RemoveE2eDockerImagesOptions = {},
): Promise<void> {
	await removeE2eDockerImages(await collectE2eDockerImageTags(systemConfig), options);
}

function throwIfE2eHarnessCleanupFailed(errors: readonly unknown[]): void {
	if (errors.length === 0) {
		return;
	}
	const [firstError] = errors;
	if (errors.length === 1 && firstError !== undefined) {
		throw firstError;
	}
	throw new AggregateError(errors, 'Smoke harness cleanup failed.');
}

function withoutStringValue(value: unknown, removedValue: string): unknown {
	if (!Array.isArray(value)) {
		return value;
	}
	return value.filter((entry) => entry !== removedValue);
}

export async function disableOpenClawMcpPortalPlugin(configPath: string): Promise<void> {
	const config = mutableJsonRecord(await loadJsonConfigFile(configPath));
	if (!config) {
		throw new Error(`OpenClaw config at ${configPath} must be an object.`);
	}
	const plugins = mutableJsonRecord(config.plugins);
	const pluginLoad = mutableJsonRecord(plugins?.load);
	if (pluginLoad) {
		pluginLoad.paths = withoutStringValue(pluginLoad.paths, defaultOpenClawMcpPortalExtensionsPath);
	}
	if (plugins) {
		plugins.allow = withoutStringValue(plugins.allow, openClawMcpPortalPluginName);
	}
	const pluginEntries = mutableJsonRecord(plugins?.entries);
	if (pluginEntries) {
		delete pluginEntries[openClawMcpPortalPluginName];
	}
	await fs.writeFile(configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}

export async function useLocalOpenClawGatewayImagePackages(options: {
	readonly enableToolVmWriteReadE2eRoute?: boolean | undefined;
	readonly profileName: string;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const gatewayProfile = options.systemConfig.imageProfiles.gateways[options.profileName];
	if (!gatewayProfile) {
		throw new Error(`Gateway image profile '${options.profileName}' is not configured.`);
	}
	const dockerContextDirectory = path.join(
		options.projectRoot,
		'vm-images',
		'gateways',
		`${options.profileName}-local-packages`,
	);
	const localAgentPortalSdkTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'agent-portal-sdk',
		repoRoot: options.repoRoot,
	});
	const localConfigContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'config-contracts',
		repoRoot: options.repoRoot,
	});
	const localSecretManagementTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'secret-management',
		repoRoot: options.repoRoot,
	});
	const localGondolinVmAdapterTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gondolin-vm-adapter',
		repoRoot: options.repoRoot,
	});
	const localGatewayLifecycleTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gateway-lifecycle',
		repoRoot: options.repoRoot,
	});
	const localGatewayRuntimeTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gateway-runtime',
		repoRoot: options.repoRoot,
	});
	const localManagedVmTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'managed-vm',
		repoRoot: options.repoRoot,
	});
	const localControlProtocolContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'control-protocol-contracts',
		repoRoot: options.repoRoot,
	});
	const localControllerExecutionContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'controller-execution-contracts',
		repoRoot: options.repoRoot,
	});
	const localGatewayControlContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gateway-control-contracts',
		repoRoot: options.repoRoot,
	});
	const localMcpPortalTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'mcp-portal',
		repoRoot: options.repoRoot,
	});
	const localToolPortalTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'tool-portal',
		repoRoot: options.repoRoot,
	});
	const localOpenClawAgentVmPluginTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'openclaw-agent-vm-plugin',
		repoRoot: options.repoRoot,
	});
	try {
		const localPackageTarballs = [
			createLocalDockerPackageTarball({
				packageName: 'agent-portal-sdk',
				sourcePath: localAgentPortalSdkTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'config-contracts',
				sourcePath: localConfigContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'secret-management',
				sourcePath: localSecretManagementTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gondolin-vm-adapter',
				sourcePath: localGondolinVmAdapterTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gateway-lifecycle',
				sourcePath: localGatewayLifecycleTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gateway-runtime',
				sourcePath: localGatewayRuntimeTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'managed-vm',
				sourcePath: localManagedVmTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'control-protocol-contracts',
				sourcePath: localControlProtocolContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'controller-execution-contracts',
				sourcePath: localControllerExecutionContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gateway-control-contracts',
				sourcePath: localGatewayControlContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'mcp-portal',
				sourcePath: localMcpPortalTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'tool-portal',
				sourcePath: localToolPortalTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'openclaw-agent-vm-plugin',
				sourcePath: localOpenClawAgentVmPluginTarballPath,
			}),
		] satisfies readonly LocalDockerPackageTarball[];

		const dockerfilePath = await writeManagedOpenClawE2eDockerfileBase({
			dockerContextDirectory,
			profileName: options.profileName,
			openClawAgentVmPackageInstallMode: 'local-overlay',
		});
		await copyLocalPackageTarballsToDockerContext({
			dockerContextDirectory,
			tarballs: localPackageTarballs,
		});
		await useLocalToolVmMcpPortalPackageTarballs({
			localAgentPortalSdkTarballPath,
			localConfigContractsTarballPath,
			localMcpPortalTarballPath,
			localSecretManagementTarballPath,
			projectRoot: options.projectRoot,
			systemConfig: options.systemConfig,
		});

		await fs.appendFile(
			dockerfilePath,
			[
				'',
				'# Local package overlay generated by the OpenClaw smoke harness.',
				...localPackageTarballs.map(
					(tarball) => `COPY ${tarball.archiveName} /tmp/${tarball.archiveName}`,
				),
				...renderLocalDockerPackageInstallLines(localPackageTarballs),
				'RUN package_root="/opt/agent-vm/local-packages/node_modules" && \\',
				'    global_package_root="$(pnpm root -g)" && \\',
				'    gateway_runtime_bin="$package_root/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js" && \\',
				'    test -f "$gateway_runtime_bin" && chmod 755 "$gateway_runtime_bin" && \\',
				'    ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime && \\',
				'    mkdir -p "$global_package_root" /home/openclaw/.openclaw/extensions && \\',
				'    ln -sfn "$package_root/@agent-vm" "$global_package_root/@agent-vm" && \\',
				'    ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" /home/openclaw/.openclaw/extensions/gondolin',
				...(options.enableToolVmWriteReadE2eRoute === true
					? [
							'RUN package_root="/opt/agent-vm/local-packages/node_modules" && \\',
							'    e2e_extension="/opt/agent-vm/e2e-openclaw-gondolin-extension" && \\',
							'    mkdir -p "$e2e_extension" && \\',
							'    cp "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist/openclaw.plugin.json" "$e2e_extension/openclaw.plugin.json" && \\',
							'    printf "%s\\n" "export { default } from \\"$package_root/@agent-vm/openclaw-agent-vm-plugin/dist/e2e.js\\";" > "$e2e_extension/index.js" && \\',
							'    ln -sfn "$e2e_extension" /home/openclaw/.openclaw/extensions/gondolin',
						]
					: []),
				'',
			].join('\n'),
			'utf8',
		);

		gatewayProfile.dockerfile = dockerfilePath;
		delete gatewayProfile.source;
	} finally {
		await removeE2eLocalPackageTarballs([
			localAgentPortalSdkTarballPath,
			localConfigContractsTarballPath,
			localSecretManagementTarballPath,
			localGondolinVmAdapterTarballPath,
			localGatewayLifecycleTarballPath,
			localGatewayRuntimeTarballPath,
			localManagedVmTarballPath,
			localControlProtocolContractsTarballPath,
			localControllerExecutionContractsTarballPath,
			localGatewayControlContractsTarballPath,
			localMcpPortalTarballPath,
			localToolPortalTarballPath,
			localOpenClawAgentVmPluginTarballPath,
		]);
	}
}

export async function useLocalOpenClawPluginGatewayImage(options: {
	readonly enableToolVmWriteReadE2eRoute?: boolean | undefined;
	readonly profileName: string;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const gatewayProfile = options.systemConfig.imageProfiles.gateways[options.profileName];
	if (!gatewayProfile) {
		throw new Error(`Gateway image profile '${options.profileName}' is not configured.`);
	}
	const dockerContextDirectory = path.join(
		options.projectRoot,
		'vm-images',
		'gateways',
		`${options.profileName}-local-plugin`,
	);
	const localAgentPortalSdkTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'agent-portal-sdk',
		repoRoot: options.repoRoot,
	});
	const localConfigContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'config-contracts',
		repoRoot: options.repoRoot,
	});
	const localSecretManagementTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'secret-management',
		repoRoot: options.repoRoot,
	});
	const localGondolinVmAdapterTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gondolin-vm-adapter',
		repoRoot: options.repoRoot,
	});
	const localGatewayLifecycleTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gateway-lifecycle',
		repoRoot: options.repoRoot,
	});
	const localGatewayRuntimeTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gateway-runtime',
		repoRoot: options.repoRoot,
	});
	const localManagedVmTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'managed-vm',
		repoRoot: options.repoRoot,
	});
	const localControlProtocolContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'control-protocol-contracts',
		repoRoot: options.repoRoot,
	});
	const localControllerExecutionContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'controller-execution-contracts',
		repoRoot: options.repoRoot,
	});
	const localGatewayControlContractsTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'gateway-control-contracts',
		repoRoot: options.repoRoot,
	});
	const localMcpPortalTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'mcp-portal',
		repoRoot: options.repoRoot,
	});
	const localToolPortalTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'tool-portal',
		repoRoot: options.repoRoot,
	});
	const localOpenClawAgentVmPluginTarballPath = await packLocalAgentVmPackageTarball({
		packageName: 'openclaw-agent-vm-plugin',
		repoRoot: options.repoRoot,
	});
	try {
		const localPackageTarballs = [
			createLocalDockerPackageTarball({
				packageName: 'agent-portal-sdk',
				sourcePath: localAgentPortalSdkTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'config-contracts',
				sourcePath: localConfigContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'secret-management',
				sourcePath: localSecretManagementTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gondolin-vm-adapter',
				sourcePath: localGondolinVmAdapterTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gateway-lifecycle',
				sourcePath: localGatewayLifecycleTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gateway-runtime',
				sourcePath: localGatewayRuntimeTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'managed-vm',
				sourcePath: localManagedVmTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'control-protocol-contracts',
				sourcePath: localControlProtocolContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'controller-execution-contracts',
				sourcePath: localControllerExecutionContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'gateway-control-contracts',
				sourcePath: localGatewayControlContractsTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'mcp-portal',
				sourcePath: localMcpPortalTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'tool-portal',
				sourcePath: localToolPortalTarballPath,
			}),
			createLocalDockerPackageTarball({
				packageName: 'openclaw-agent-vm-plugin',
				sourcePath: localOpenClawAgentVmPluginTarballPath,
			}),
		] satisfies readonly LocalDockerPackageTarball[];

		const dockerfilePath = await writeManagedOpenClawE2eDockerfileBase({
			dockerContextDirectory,
			profileName: options.profileName,
			openClawAgentVmPackageInstallMode: 'local-overlay',
		});
		await copyLocalPackageTarballsToDockerContext({
			dockerContextDirectory,
			tarballs: localPackageTarballs,
		});

		await fs.appendFile(
			dockerfilePath,
			[
				'',
				'# Local plugin overlay generated by the OpenClaw smoke harness.',
				...localPackageTarballs.map(
					(tarball) => `COPY ${tarball.archiveName} /tmp/${tarball.archiveName}`,
				),
				...renderLocalDockerPackageInstallLines(localPackageTarballs),
				'RUN package_root="/opt/agent-vm/local-packages/node_modules" && \\',
				'    global_package_root="$(pnpm root -g)" && \\',
				'    gateway_runtime_bin="$package_root/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js" && \\',
				'    test -f "$gateway_runtime_bin" && chmod 755 "$gateway_runtime_bin" && \\',
				'    ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime && \\',
				'    mkdir -p "$global_package_root" /home/openclaw/.openclaw/extensions && \\',
				'    ln -sfn "$package_root/@agent-vm" "$global_package_root/@agent-vm" && \\',
				'    ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" /home/openclaw/.openclaw/extensions/gondolin',
				...(options.enableToolVmWriteReadE2eRoute === true
					? [
							'RUN package_root="/opt/agent-vm/local-packages/node_modules" && \\',
							'    e2e_extension="/opt/agent-vm/e2e-openclaw-gondolin-extension" && \\',
							'    mkdir -p "$e2e_extension" && \\',
							'    cp "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist/openclaw.plugin.json" "$e2e_extension/openclaw.plugin.json" && \\',
							'    printf "%s\\n" "export { default } from \\"$package_root/@agent-vm/openclaw-agent-vm-plugin/dist/e2e.js\\";" > "$e2e_extension/index.js" && \\',
							'    ln -sfn "$e2e_extension" /home/openclaw/.openclaw/extensions/gondolin',
						]
					: []),
				'',
			].join('\n'),
			'utf8',
		);

		gatewayProfile.dockerfile = dockerfilePath;
		delete gatewayProfile.source;
	} finally {
		await removeE2eLocalPackageTarballs([
			localAgentPortalSdkTarballPath,
			localConfigContractsTarballPath,
			localSecretManagementTarballPath,
			localGondolinVmAdapterTarballPath,
			localGatewayLifecycleTarballPath,
			localGatewayRuntimeTarballPath,
			localManagedVmTarballPath,
			localControlProtocolContractsTarballPath,
			localControllerExecutionContractsTarballPath,
			localGatewayControlContractsTarballPath,
			localMcpPortalTarballPath,
			localToolPortalTarballPath,
			localOpenClawAgentVmPluginTarballPath,
		]);
	}
}

export async function scaffoldOpenClawE2eProject(options: {
	readonly agents?: readonly string[];
	readonly architecture: ImageArchitecture;
	readonly prefix: string;
	readonly zoneId: string;
}): Promise<OpenClawE2eProject> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
	const controllerPort = await findAvailablePort();
	const gatewayPort = await findAvailablePort();
	await scaffoldAgentVmProject({
		architecture: options.architecture,
		gatewayType: 'openclaw',
		secretsProvider: 'environment',
		targetDir: tempRoot,
		zoneId: options.zoneId,
		...(options.agents ? { agents: options.agents } : {}),
	});
	const loadedSystemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.json'));
	const systemConfig: LoadedSystemConfig = {
		...loadedSystemConfig,
		cacheDir: path.join(resolveE2eCacheRoot(), 'openclaw'),
	};
	systemConfig.host.controllerPort = controllerPort;
	systemConfig.host.projectNamespace = 'claw-tests-workspace-git';
	const zone = getOpenClawE2eZone(systemConfig);
	zone.gateway.port = gatewayPort;
	return {
		controllerPort,
		gatewayPort,
		systemConfig,
		tempRoot,
		zone,
	};
}

export async function prepareLocalWorkerPackageForGatewayImage(repoRoot: string): Promise<string> {
	return await packLocalPackageTarball({
		packageDirectory: path.join(repoRoot, 'packages', 'agent-vm-worker'),
		packageName: 'agent-vm-worker',
	});
}

export interface LocalWorkerPackageTarball {
	readonly packageName: string;
	readonly sourcePath: string;
}

export async function prepareLocalWorkerPackageSetForGatewayImage(
	repoRoot: string,
): Promise<readonly LocalWorkerPackageTarball[]> {
	const packageNames = [
		'agent-vm-worker',
		'control-protocol-contracts',
		'gateway-lifecycle',
		'gondolin-vm-adapter',
		'managed-vm',
		'secret-management',
		'worker-control-contracts',
	] as const;
	return await Promise.all(
		packageNames.map(async (packageName) => ({
			packageName,
			sourcePath: await packLocalAgentVmPackageTarball({
				packageName,
				repoRoot,
			}),
		})),
	);
}

export async function scaffoldWorkerE2eProject(options: {
	readonly architecture: ImageArchitecture;
	readonly prefix: string;
	readonly zoneId: string;
}): Promise<WorkerE2eProject> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
	const controllerPort = await findAvailablePort();
	const gatewayPort = await findAvailablePort();
	await scaffoldAgentVmProject({
		architecture: options.architecture,
		gatewayType: 'worker',
		secretsProvider: '1password',
		targetDir: tempRoot,
		zoneId: options.zoneId,
	});
	const loadedSystemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.json'));
	const systemConfig: LoadedSystemConfig = {
		...loadedSystemConfig,
		cacheDir: path.join(resolveE2eCacheRoot(), 'worker'),
	};
	systemConfig.host.controllerPort = controllerPort;
	systemConfig.host.projectNamespace = 'claw-tests-worker';
	systemConfig.host.secretsProvider = {
		type: '1password',
		tokenSource: { type: 'env', envVar: 'AGENT_VM_TEST_OPENAI_API_KEY' },
	};
	const zone = getWorkerE2eZone(systemConfig);
	zone.gateway.port = gatewayPort;
	return {
		controllerPort,
		gatewayPort,
		systemConfig,
		tempRoot,
		zone,
	};
}

export async function scaffoldGatewayE2eProject(
	options: ScaffoldGatewayE2eProjectOptions,
): Promise<GatewayE2eProject> {
	if (options.kind === 'openclaw') {
		return await scaffoldOpenClawE2eProject({
			architecture: options.architecture,
			prefix: options.prefix,
			zoneId: options.zoneId,
			...(options.agents ? { agents: options.agents } : {}),
		});
	}
	return await scaffoldWorkerE2eProject({
		architecture: options.architecture,
		prefix: options.prefix,
		zoneId: options.zoneId,
	});
}

export async function writeOpenClawMcpPortalE2eConfigs(options: {
	readonly agentId: string;
	readonly configDir: string;
	readonly namespace: string;
	readonly upstreamUrl: string;
}): Promise<void> {
	await fs.writeFile(
		path.join(options.configDir, 'mcp.config.jsonc'),
		`${JSON.stringify(
			{
				$schema: '../../schemas/mcp.schema.json',
				providers: {
					upstreamMock: {
						discovery: { summary: 'Mock upstream MCP server for e2e tests' },
						kind: 'mcp',
						namespace: options.namespace,
						transport: {
							kind: 'streamable-http',
							url: options.upstreamUrl,
						},
					},
				},
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(
		path.join(options.configDir, 'tool-portal.config.jsonc'),
		`${JSON.stringify(
			{
				$schema: '../../schemas/tool-portal.schema.json',
				agents: {
					[options.agentId]: { profile: 'smoke' },
				},
				mode: 'managed',
				profiles: {
					smoke: {
						namespaces: {
							[options.namespace]: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['read_thing'] },
								},
								tools: { allow: ['read_thing', 'write_thing'] },
							},
						},
					},
				},
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
}

export async function startE2eControllerRuntime(
	options: StartE2eControllerRuntimeOptions,
): Promise<E2eHarnessRuntime> {
	const restoreEnvironment = applySmokeEnvironment(options.secrets);
	const secretResolver = createSmokeSecretResolver(options.secrets);
	const tempRoot = path.dirname(path.dirname(options.startOptions.systemConfig.systemConfigPath));
	try {
		const managedVmFactory =
			options.onControllerManagedVmCreateRequest === undefined
				? managedVmRuntimeComposition.managedVmFactory
				: {
						createManagedVm: async (request: ManagedVmCreateRequest) => {
							options.onControllerManagedVmCreateRequest?.(request);
							return await managedVmRuntimeComposition.managedVmFactory.createManagedVm(request);
						},
					};
		const runtime = await startControllerRuntime(options.startOptions, {
			...managedVmRuntimeComposition,
			managedVmFactory,
			createSecretResolver: async (): Promise<SecretResolver> => secretResolver,
			...(options.onLeaseCreateRequest === undefined
				? {}
				: { onLeaseCreateRequest: options.onLeaseCreateRequest }),
			...(options.startHttpServer === undefined
				? {}
				: { startHttpServer: options.startHttpServer }),
			...(options.startGatewayZone === undefined &&
			options.tcpHostsOverride === undefined &&
			options.vfsMountsOverride === undefined
				? {}
				: {
						startGatewayZone: async (startGatewayOptions: StartGatewayZoneOptions) => {
							const mergedOptions = {
								...startGatewayOptions,
								tcpHostsOverride: {
									...startGatewayOptions.tcpHostsOverride,
									...options.tcpHostsOverride,
								},
								vfsMountsOverride: {
									...startGatewayOptions.vfsMountsOverride,
									...options.vfsMountsOverride,
								},
							};
							return options.startGatewayZone === undefined
								? await startE2eGatewayZoneForController(mergedOptions)
								: await options.startGatewayZone(mergedOptions, managedVmRuntimeComposition);
						},
					}),
		});
		if (options.startHttpServer === undefined) {
			await waitForControllerReady(options.startOptions.systemConfig.host.controllerPort);
		}
		return {
			controllerUrl: `http://127.0.0.1:${options.startOptions.systemConfig.host.controllerPort}`,
			runtime,
			systemConfig: options.startOptions.systemConfig,
			tempRoot,
			close: async (closeOptions = {}) => {
				const cleanupErrors: unknown[] = [];
				try {
					await runtime.close();
				} catch (error) {
					cleanupErrors.push(error);
				}
				if (
					shouldCleanupE2eDockerImages({
						...closeOptions,
						env: process.env,
					})
				) {
					try {
						await removeE2eDockerImagesForSystemConfig(options.startOptions.systemConfig);
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
				try {
					if (closeOptions.preserveTempRoot !== true) {
						await removeE2eTempRoot(tempRoot);
					}
				} catch (error) {
					cleanupErrors.push(error);
				} finally {
					restoreEnvironment();
				}
				throwIfE2eHarnessCleanupFailed(cleanupErrors);
			},
		};
	} catch (error) {
		const cleanupErrors: unknown[] = [error];
		if (shouldCleanupE2eDockerImages({ env: process.env })) {
			try {
				await removeE2eDockerImagesForSystemConfig(options.startOptions.systemConfig);
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		try {
			await removeE2eTempRoot(tempRoot);
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		} finally {
			restoreEnvironment();
		}
		throwIfE2eHarnessCleanupFailed(cleanupErrors);
		throw error;
	}
}
