import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { hasBuiltImageAssets, resolveGondolinMinimumZigVersion } from '@agent-vm/gondolin-adapter';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import {
	generateManagedDockerfile,
	resolveManagedImageRelease,
} from '../build/managed-image-dockerfile.js';
import { isZigVersionAtLeast, resolveHostZigVersion } from '../build/zig-compatibility.js';
import { scaffoldAgentVmProject, type ImageArchitecture } from '../cli/init-command.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import { loadSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type {
	ControllerRuntime,
	ControllerRuntimeDependencies,
	StartControllerRuntimeOptions,
} from '../controller/controller-runtime-types.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { StartGatewayZoneOptions } from '../gateway/gateway-zone-support.js';

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

interface LocalDockerPackageTarball {
	readonly archiveName: string;
	readonly sourcePath: string;
}

const defaultOpenClawMcpPortalExtensionsPath = '/home/openclaw/.openclaw/extensions/mcp-portal';
const execFileAsync = promisify(execFile);
const openClawMcpPortalPluginName = 'mcp-portal';
const e2eTempRootPrefixes = [
	'agent-vm-gateway-e2e-project-',
	'agent-vm-e2e-harness-',
	'openclaw-control-link-e2e-',
	'openclaw-mcp-portal-e2e-',
	'openclaw-subagent-lease-e2e-',
	'openclaw-zone-git-e2e-',
	'worker-loop-e2e-',
] as const;

function resolveE2eCacheRoot(): string {
	const configuredCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
	if (configuredCacheRoot !== undefined && configuredCacheRoot.length > 0) {
		return path.resolve(configuredCacheRoot);
	}
	return path.join(os.tmpdir(), 'agent-vm-e2e-cache');
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

export interface ScaffoldGatewayE2eProjectOptions {
	readonly agents?: readonly string[];
	readonly architecture: ImageArchitecture;
	readonly kind: GatewayE2eKind;
	readonly prefix: string;
	readonly zoneId: string;
}

export interface GondolinE2ePrerequisiteOptions {
	readonly architecture: ImageArchitecture;
	readonly commandExists?: (command: string) => boolean;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
}

export interface StartE2eControllerRuntimeOptions {
	readonly onLeaseCreateRequest?: ControllerRuntimeDependencies['onLeaseCreateRequest'];
	readonly secrets: E2eHarnessSecretMap;
	readonly startGatewayZone?: typeof startGatewayZone;
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

export async function canRunGondolinE2e(options: GondolinE2ePrerequisiteOptions): Promise<boolean> {
	const commandExists = options.commandExists ?? hasCommand;
	if (
		!commandExists(qemuCommandForArchitecture(options.architecture)) ||
		!commandExists('docker')
	) {
		return false;
	}
	const requiredZigVersion = await (
		options.resolveRequiredZigVersion ?? resolveGondolinMinimumZigVersion
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
	return await canRunGondolinE2e({
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

export async function waitForControllerReady(controllerPort: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- readiness polling is sequential
		const response = await fetch(`http://127.0.0.1:${controllerPort}/controller-status`).catch(
			() => null,
		);
		if (response?.ok) {
			return;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- readiness polling is sequential
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error('Controller did not become ready in time.');
}

export async function findReusableGatewayImageDirectory(
	currentProjectRoot: string,
	gatewayBuildConfigPath: string,
	imageProfileName = 'worker',
): Promise<string | null> {
	const explicitE2eCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
	if (!explicitE2eCacheRoot) {
		return null;
	}
	const requiredFingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath);
	const tempRootEntries = await fs.readdir(explicitE2eCacheRoot, { withFileTypes: true });
	const e2eRunDirectories = tempRootEntries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(explicitE2eCacheRoot, entry.name));

	for (const e2eRunDirectory of e2eRunDirectories) {
		if (e2eRunDirectory === currentProjectRoot) {
			continue;
		}
		const candidateImageDirectories = [
			path.join(e2eRunDirectory, 'gateway-images', imageProfileName, requiredFingerprint),
			path.join(e2eRunDirectory, 'cache', 'gateway-images', imageProfileName, requiredFingerprint),
		];
		for (const candidateImageDir of candidateImageDirectories) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- intentionally searches cache candidates
			if (await hasBuiltImageAssets(candidateImageDir)) {
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
}): Promise<void> {
	const imageProfileName = options.imageProfileName ?? 'worker';
	const reusableImageDir = await findReusableGatewayImageDirectory(
		options.currentProjectRoot,
		options.gatewayBuildConfigPath,
		imageProfileName,
	);
	if (!reusableImageDir) {
		return;
	}

	const requiredFingerprint = await computeFingerprintFromConfigPath(
		options.gatewayBuildConfigPath,
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

async function packLocalPackageTarball(props: LocalNpmPackageTarball): Promise<string> {
	const packageJsonPath = path.join(props.packageDirectory, 'package.json');
	await fs.access(packageJsonPath);
	await assertLocalPackageFilesExist(props);
	const packDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `${props.packageName}-pack-`));
	try {
		execFileSync('pnpm', [...resolveLocalPackagePackArgs(packDirectory)], {
			cwd: props.packageDirectory,
			stdio: 'pipe',
		});
		const packedTarballs = (await fs.readdir(packDirectory)).filter((fileName) =>
			fileName.endsWith('.tgz'),
		);
		const [packedTarballName] = packedTarballs;
		if (packedTarballName === undefined) {
			throw new Error(`Failed to pack local ${props.packageName} tarball for smoke image.`);
		}
		if (packedTarballs.length > 1) {
			throw new Error(
				`Expected pnpm pack for ${props.packageName} to produce exactly one tarball.`,
			);
		}
		return path.join(packDirectory, packedTarballName);
	} catch (error) {
		await fs.rm(packDirectory, { force: true, recursive: true });
		throw error;
	}
}

async function removeLocalPackageTarballDirectories(
	tarballPaths: readonly (string | undefined)[],
): Promise<void> {
	await Promise.all(
		Array.from(
			new Set(
				tarballPaths
					.filter((tarballPath): tarballPath is string => tarballPath !== undefined)
					.map((tarballPath) => path.dirname(tarballPath)),
			),
		).map(async (packDirectory) => {
			await fs.rm(packDirectory, { force: true, recursive: true });
		}),
	);
}

async function copyLocalPackageTarballsToDockerContext(options: {
	readonly dockerContextDirectory: string;
	readonly tarballs: readonly LocalDockerPackageTarball[];
}): Promise<void> {
	await Promise.all(
		options.tarballs.map(async (tarball) => {
			await fs.copyFile(
				tarball.sourcePath,
				path.join(options.dockerContextDirectory, tarball.archiveName),
			);
		}),
	);
}

async function useLocalToolVmMcpPortalPackageTarballs(options: {
	readonly localConfigContractsTarballPath: string;
	readonly localMcpPortalTarballPath: string;
	readonly localSecretManagementTarballPath: string;
	readonly projectRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const managedImageRelease = await resolveManagedImageRelease();
	const baseImage = managedImageRelease.baseImages['tool-vm'];
	const toolVmProfiles = Object.entries(options.systemConfig.imageProfiles.toolVms);
	await Promise.all(
		toolVmProfiles.map(async ([profileName, toolVmProfile]): Promise<void> => {
			const dockerContextDirectory = path.join(
				options.projectRoot,
				'vm-images',
				'tool-vms',
				`${profileName}-local-mcp-portal`,
			);
			const dockerfilePath = path.join(dockerContextDirectory, 'Dockerfile');
			const localConfigContractsTarballName = 'config-contracts-local.tgz';
			const localSecretManagementTarballName = 'secret-management-local.tgz';
			const localTarballName = 'mcp-portal-local.tgz';
			await fs.rm(dockerContextDirectory, { force: true, recursive: true });
			await fs.mkdir(dockerContextDirectory, { recursive: true });
			await copyLocalPackageTarballsToDockerContext({
				dockerContextDirectory,
				tarballs: [
					{
						archiveName: localConfigContractsTarballName,
						sourcePath: options.localConfigContractsTarballPath,
					},
					{
						archiveName: localSecretManagementTarballName,
						sourcePath: options.localSecretManagementTarballPath,
					},
					{ archiveName: localTarballName, sourcePath: options.localMcpPortalTarballPath },
				],
			});
			await fs.writeFile(
				dockerfilePath,
				[
					`FROM ${baseImage.repository}:${baseImage.tag}`,
					'',
					'# Generated by the OpenClaw smoke harness from the local MCP Portal package.',
					'COPY config-contracts-local.tgz /tmp/config-contracts-local.tgz',
					'COPY secret-management-local.tgz /tmp/secret-management-local.tgz',
					'COPY mcp-portal-local.tgz /tmp/mcp-portal-local.tgz',
					'RUN mkdir -p /opt/agent-vm/local-packages && \\',
					'    npm install --omit=dev --no-audit --no-fund --prefix /opt/agent-vm/local-packages /tmp/config-contracts-local.tgz /tmp/secret-management-local.tgz /tmp/mcp-portal-local.tgz && \\',
					'    rm -f /tmp/config-contracts-local.tgz /tmp/secret-management-local.tgz /tmp/mcp-portal-local.tgz',
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
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const localConfigContractsTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'config-contracts'),
		packageName: 'config-contracts',
	});
	const localSecretManagementTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'secret-management'),
		packageName: 'secret-management',
	});
	const localMcpPortalTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'mcp-portal'),
		packageName: 'mcp-portal',
	});
	try {
		await useLocalToolVmMcpPortalPackageTarballs({
			localConfigContractsTarballPath,
			localMcpPortalTarballPath,
			localSecretManagementTarballPath,
			projectRoot: options.projectRoot,
			systemConfig: options.systemConfig,
		});
	} finally {
		await removeLocalPackageTarballDirectories([
			localConfigContractsTarballPath,
			localSecretManagementTarballPath,
			localMcpPortalTarballPath,
		]);
	}
}

function localPackageTarballArchiveName(packageName: string): string {
	return `${packageName}-local.tgz`;
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
	const localConfigContractsTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'config-contracts'),
		packageName: 'config-contracts',
	});
	const localSecretManagementTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'secret-management'),
		packageName: 'secret-management',
	});
	const localGondolinAdapterTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'gondolin-adapter'),
		packageName: 'gondolin-adapter',
	});
	const localGatewayInterfaceTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'gateway-interface'),
		packageName: 'gateway-interface',
	});
	const localMcpPortalTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'mcp-portal'),
		packageName: 'mcp-portal',
	});
	const localOpenClawAgentVmPluginTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'openclaw-agent-vm-plugin'),
		packageName: 'openclaw-agent-vm-plugin',
	});
	const localOpenClawMcpPortalPluginTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'openclaw-mcp-portal-plugin'),
		packageName: 'openclaw-mcp-portal-plugin',
	});
	try {
		const localPackageTarballs = [
			{
				archiveName: localPackageTarballArchiveName('config-contracts'),
				sourcePath: localConfigContractsTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('secret-management'),
				sourcePath: localSecretManagementTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('gondolin-adapter'),
				sourcePath: localGondolinAdapterTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('gateway-interface'),
				sourcePath: localGatewayInterfaceTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('mcp-portal'),
				sourcePath: localMcpPortalTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('openclaw-agent-vm-plugin'),
				sourcePath: localOpenClawAgentVmPluginTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('openclaw-mcp-portal-plugin'),
				sourcePath: localOpenClawMcpPortalPluginTarballPath,
			},
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
				'RUN mkdir -p /opt/agent-vm/local-packages && \\',
				'    npm install --omit=dev --no-audit --no-fund --prefix /opt/agent-vm/local-packages ' +
					localPackageTarballs.map((tarball) => `/tmp/${tarball.archiveName}`).join(' ') +
					' && \\',
				'    rm -f ' +
					localPackageTarballs.map((tarball) => `/tmp/${tarball.archiveName}`).join(' '),
				'RUN package_root="/opt/agent-vm/local-packages/node_modules" && \\',
				'    global_package_root="$(pnpm root -g)" && \\',
				'    mkdir -p "$global_package_root" /home/openclaw/.openclaw/extensions && \\',
				'    ln -sfn "$package_root/@agent-vm" "$global_package_root/@agent-vm" && \\',
				'    ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" /home/openclaw/.openclaw/extensions/gondolin && \\',
				'    ln -sfn "$package_root/@agent-vm/openclaw-mcp-portal-plugin/dist" /home/openclaw/.openclaw/extensions/mcp-portal',
				'',
			].join('\n'),
			'utf8',
		);

		gatewayProfile.dockerfile = dockerfilePath;
		delete gatewayProfile.source;
	} finally {
		await removeLocalPackageTarballDirectories([
			localConfigContractsTarballPath,
			localSecretManagementTarballPath,
			localGondolinAdapterTarballPath,
			localGatewayInterfaceTarballPath,
			localMcpPortalTarballPath,
			localOpenClawAgentVmPluginTarballPath,
			localOpenClawMcpPortalPluginTarballPath,
		]);
	}
}

export async function useLocalOpenClawPluginGatewayImage(options: {
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
	const localSecretManagementTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'secret-management'),
		packageName: 'secret-management',
	});
	const localGondolinAdapterTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'gondolin-adapter'),
		packageName: 'gondolin-adapter',
	});
	const localGatewayInterfaceTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'gateway-interface'),
		packageName: 'gateway-interface',
	});
	const localOpenClawAgentVmPluginTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'openclaw-agent-vm-plugin'),
		packageName: 'openclaw-agent-vm-plugin',
	});
	try {
		const localPackageTarballs = [
			{
				archiveName: localPackageTarballArchiveName('secret-management'),
				sourcePath: localSecretManagementTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('gondolin-adapter'),
				sourcePath: localGondolinAdapterTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('gateway-interface'),
				sourcePath: localGatewayInterfaceTarballPath,
			},
			{
				archiveName: localPackageTarballArchiveName('openclaw-agent-vm-plugin'),
				sourcePath: localOpenClawAgentVmPluginTarballPath,
			},
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
				'RUN mkdir -p /opt/agent-vm/local-packages && \\',
				'    npm install --omit=dev --no-audit --no-fund --prefix /opt/agent-vm/local-packages ' +
					localPackageTarballs.map((tarball) => `/tmp/${tarball.archiveName}`).join(' ') +
					' && \\',
				'    rm -f ' +
					localPackageTarballs.map((tarball) => `/tmp/${tarball.archiveName}`).join(' '),
				'RUN package_root="/opt/agent-vm/local-packages/node_modules" && \\',
				'    global_package_root="$(pnpm root -g)" && \\',
				'    mkdir -p "$global_package_root" /home/openclaw/.openclaw/extensions && \\',
				'    ln -sfn "$package_root/@agent-vm" "$global_package_root/@agent-vm" && \\',
				'    ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" /home/openclaw/.openclaw/extensions/gondolin',
				'',
			].join('\n'),
			'utf8',
		);

		gatewayProfile.dockerfile = dockerfilePath;
		delete gatewayProfile.source;
	} finally {
		await removeLocalPackageTarballDirectories([
			localSecretManagementTarballPath,
			localGondolinAdapterTarballPath,
			localGatewayInterfaceTarballPath,
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
	const systemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.json'));
	systemConfig.host.controllerPort = controllerPort;
	systemConfig.host.projectNamespace = 'claw-tests-zone-git';
	systemConfig.cacheDir = path.join(resolveE2eCacheRoot(), 'openclaw');
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
	await fs.mkdir(path.join(repoRoot, 'tmp'), { recursive: true });
	const packDirectory = await fs.mkdtemp(path.join(repoRoot, 'tmp', 'agent-vm-worker-pack-'));
	execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], {
		cwd: path.join(repoRoot, 'packages', 'agent-vm-worker'),
		stdio: 'pipe',
	});
	const packedTarballs = (await fs.readdir(packDirectory)).filter((fileName) =>
		fileName.endsWith('.tgz'),
	);
	const [packedTarballName] = packedTarballs;
	if (packedTarballName === undefined) {
		throw new Error('Failed to pack local agent-vm-worker tarball for smoke image.');
	}
	if (packedTarballs.length > 1) {
		throw new Error('Expected pnpm pack to produce exactly one agent-vm-worker tarball.');
	}
	return path.join(packDirectory, packedTarballName);
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
	const systemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.json'));
	systemConfig.host.controllerPort = controllerPort;
	systemConfig.host.projectNamespace = 'claw-tests-worker';
	systemConfig.cacheDir = path.join(resolveE2eCacheRoot(), 'worker');
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
	readonly portalAccessHeaderName: string;
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
		path.join(options.configDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(
			{
				$schema: '../../schemas/mcp-portal.schema.json',
				agents: {
					[options.agentId]: { profile: 'smoke' },
				},
				profiles: {
					smoke: {
						namespaces: {
							[options.namespace]: {
								calls: {
									requiresApproval: { allow: ['write_thing'] },
									withoutApproval: { allow: ['read_thing'] },
								},
								tools: { allow: ['read_thing', 'write_thing'] },
							},
						},
						promptContext: { enabled: true, maxNamespaces: 12 },
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
		const runtime = await startControllerRuntime(options.startOptions, {
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
						startGatewayZone: async (startGatewayOptions: StartGatewayZoneOptions) =>
							await (options.startGatewayZone ?? startGatewayZone)({
								...startGatewayOptions,
								tcpHostsOverride: {
									...startGatewayOptions.tcpHostsOverride,
									...options.tcpHostsOverride,
								},
								vfsMountsOverride: {
									...startGatewayOptions.vfsMountsOverride,
									...options.vfsMountsOverride,
								},
							}),
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
					await removeE2eTempRoot(tempRoot);
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
