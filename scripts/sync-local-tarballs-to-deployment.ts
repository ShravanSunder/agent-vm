import { execFile, spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	renderHermesManagedImageRecipe,
	type HermesManagedImageBuildTarget,
} from '../packages/hermes-gateway/src/index.ts';
import { stripJsonComments } from './jsonc-comments.ts';

const execFileAsync = promisify(execFile);

export const AGENT_VM_PACKAGE_NAMES = [
	'@agent-vm/agent-vm',
	'@agent-vm/agent-portal-sdk',
	'@agent-vm/agent-vm-worker',
	'@agent-vm/config-contracts',
	'@agent-vm/control-protocol-contracts',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/gateway-control-contracts',
	'@agent-vm/gateway-lifecycle',
	'@agent-vm/gateway-runtime',
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/hermes-gateway',
	'@agent-vm/managed-vm',
	'@agent-vm/mcp-portal',
	'@agent-vm/secret-management',
	'@agent-vm/tool-portal',
	'@agent-vm/worker-control-contracts',
	'@agent-vm/worker-gateway',
] as const;

export const TOOL_VM_TARBALL_PACKAGE_NAMES = [
	'@agent-vm/agent-portal-sdk',
	'@agent-vm/config-contracts',
	'@agent-vm/secret-management',
	'@agent-vm/mcp-portal',
] as const;

export const HERMES_GATEWAY_TARBALL_PACKAGE_NAMES = [
	'@agent-vm/agent-portal-sdk',
	'@agent-vm/config-contracts',
	'@agent-vm/control-protocol-contracts',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/gateway-control-contracts',
	'@agent-vm/secret-management',
	'@agent-vm/mcp-portal',
	'@agent-vm/tool-portal',
	'@agent-vm/gateway-runtime',
] as const;

type AgentVmPackageName = (typeof AGENT_VM_PACKAGE_NAMES)[number];

interface BetaTarballPackageEntry {
	readonly fileName: string;
	readonly name: AgentVmPackageName;
	readonly overlayFileName: string;
	readonly specifier: string;
}

export interface BetaTarballSyncPlan {
	readonly hermesGatewayPackages: readonly BetaTarballPackageEntry[];
	readonly hostPackageSpecifier: string;
	readonly packages: readonly BetaTarballPackageEntry[];
	readonly tarballDirectoryReference: string;
	readonly toolVmPackages: readonly BetaTarballPackageEntry[];
	readonly version: string;
}

interface CreateBetaTarballSyncPlanOptions {
	readonly cacheKey: string;
	readonly tarballDirectoryReference: string;
	readonly version: string;
}

type JsonRecord = Record<string, unknown>;

interface UpdateBetaPackageManifestOptions {
	readonly manifest: JsonRecord;
	readonly plan: BetaTarballSyncPlan;
}

interface RenderBetaPnpmWorkspaceOptions {
	readonly onlyBuiltDependencies: readonly string[];
	readonly plan: BetaTarballSyncPlan;
}

interface OverlayCopyEntry {
	readonly from: string;
	readonly to: string;
}

interface ManagedImageOverlay {
	readonly copy?: readonly OverlayCopyEntry[];
	readonly extraAptPackages?: readonly string[];
	readonly runAfterBase?: readonly string[];
	readonly [key: string]: unknown;
}

interface RenderToolVmOverlayOptions {
	readonly existingOverlay: ManagedImageOverlay;
	readonly plan: BetaTarballSyncPlan;
}

interface SyncBetaTarballsOptions {
	readonly deploymentDirectory: string;
	readonly hash?: string;
	readonly repositoryDirectory: string;
	readonly skipBuild: boolean;
	readonly skipInstall: boolean;
}

interface ResolvePnpmPackArgsOptions {
	readonly packageName: AgentVmPackageName;
	readonly tarballDirectory: string;
}

interface RefreshBetaDeploymentTarballArtifactsOptions {
	readonly deploymentDirectory: string;
	readonly hermesImage?: HermesBetaImageArtifacts | undefined;
	readonly plan: BetaTarballSyncPlan;
	readonly tarballDirectory: string;
}

export interface HermesBetaPythonWheelArtifact {
	readonly fileName: string;
	readonly sourcePath: string;
}

export interface HermesBetaImageArtifacts {
	readonly buildTarget: HermesManagedImageBuildTarget;
	readonly pythonWheels: {
		readonly agentPortalSdk: HermesBetaPythonWheelArtifact;
		readonly hermesAdapter: HermesBetaPythonWheelArtifact;
	};
}

interface RunCommandOptions {
	readonly cwd: string;
	readonly environment?: Readonly<Record<string, string>>;
}

export function resolvePnpmPackArgs(options: ResolvePnpmPackArgsOptions): readonly string[] {
	return [
		'--filter',
		options.packageName,
		'pack',
		'--pack-destination',
		options.tarballDirectory,
		'--json',
		'--config.ignore-scripts=true',
	];
}

export function resolveBetaPnpmInstallArgs(): readonly string[] {
	return ['install', '--no-frozen-lockfile'];
}

export function resolveBetaPnpmInstallEnvironment(): Readonly<Record<string, string>> {
	return {
		CI: 'true',
		PNPM_CONFIG_CONFIRM_MODULES_PURGE: 'false',
	};
}

function packageTarballFileName(packageName: AgentVmPackageName, version: string): string {
	return `${packageName.replace('@agent-vm/', 'agent-vm-')}-${version}.tgz`;
}

function createPackageEntry(
	packageName: AgentVmPackageName,
	options: CreateBetaTarballSyncPlanOptions,
): BetaTarballPackageEntry {
	const fileName = packageTarballFileName(packageName, options.version);
	const overlayFileName = fileName.replace(/\.tgz$/u, `-${options.cacheKey}.tgz`);
	return {
		fileName,
		name: packageName,
		overlayFileName,
		specifier: `file:${options.tarballDirectoryReference}/${fileName}`,
	};
}

export function createBetaTarballSyncPlan(
	options: CreateBetaTarballSyncPlanOptions,
): BetaTarballSyncPlan {
	const packages = AGENT_VM_PACKAGE_NAMES.map((packageName) =>
		createPackageEntry(packageName, options),
	);
	const packageEntryByName = new Map(
		packages.map((packageEntry) => [packageEntry.name, packageEntry]),
	);
	const hermesGatewayPackages = HERMES_GATEWAY_TARBALL_PACKAGE_NAMES.map((packageName) => {
		const packageEntry = packageEntryByName.get(packageName);
		if (!packageEntry) {
			throw new Error(`Internal error: ${packageName} is missing from package plan.`);
		}
		return packageEntry;
	});
	const toolVmPackages = TOOL_VM_TARBALL_PACKAGE_NAMES.map((packageName) => {
		const packageEntry = packageEntryByName.get(packageName);
		if (!packageEntry) {
			throw new Error(`Internal error: ${packageName} is missing from package plan.`);
		}
		return packageEntry;
	});
	const hostPackageEntry = packages.find(
		(packageEntry) => packageEntry.name === '@agent-vm/agent-vm',
	);
	if (!hostPackageEntry) {
		throw new Error('Internal error: @agent-vm/agent-vm is missing from package plan.');
	}
	return {
		hermesGatewayPackages,
		hostPackageSpecifier: hostPackageEntry.specifier,
		packages,
		tarballDirectoryReference: options.tarballDirectoryReference,
		toolVmPackages,
		version: options.version,
	};
}

export function renderBetaPnpmWorkspace(options: RenderBetaPnpmWorkspaceOptions): string {
	const lines = ['packages: []', ''];
	if (options.onlyBuiltDependencies.length > 0) {
		lines.push('onlyBuiltDependencies:');
		for (const dependencyName of options.onlyBuiltDependencies) {
			lines.push(`  - ${JSON.stringify(dependencyName)}`);
		}
		lines.push('');
	}
	lines.push('overrides:');
	for (const packageEntry of options.plan.packages) {
		lines.push(`  '${packageEntry.name}': ${packageEntry.specifier}`);
	}
	return `${lines.join('\n')}\n`;
}

export function listStaleLocalOverlayFileNames(options: {
	readonly additionalCurrentFileNames?: readonly string[];
	readonly existingFileNames: readonly string[];
	readonly packageEntries: readonly BetaTarballPackageEntry[];
}): readonly string[] {
	const currentOverlayFileNames = new Set([
		...options.packageEntries.map((packageEntry) => packageEntry.overlayFileName),
		...(options.additionalCurrentFileNames ?? []),
	]);
	return options.existingFileNames.filter(
		(fileName) => fileName.startsWith('agent-vm-') && !currentOverlayFileNames.has(fileName),
	);
}

export function updateBetaPackageManifest(options: UpdateBetaPackageManifestOptions): JsonRecord {
	const updatedManifest: JsonRecord = { ...options.manifest };
	const dependencies = isJsonRecord(updatedManifest.dependencies)
		? { ...updatedManifest.dependencies }
		: {};
	dependencies['@agent-vm/agent-vm'] = options.plan.hostPackageSpecifier;
	updatedManifest.dependencies = dependencies;
	delete updatedManifest.pnpm;
	return updatedManifest;
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentVmLocalCopyEntry(copyEntry: OverlayCopyEntry): boolean {
	return (
		copyEntry.from.startsWith('local-agent-vm/agent-vm-') ||
		copyEntry.to.startsWith('/tmp/agent-vm-')
	);
}

function isAgentVmLocalInstallCommand(command: string): boolean {
	return (
		command.includes('/opt/agent-vm/local-packages') ||
		command.includes('/tmp/agent-vm-') ||
		command.includes('@agent-vm/')
	);
}

function renderLocalPackageManifest(packageEntries: readonly BetaTarballPackageEntry[]): string {
	const dependencies = Object.fromEntries(
		packageEntries.map((packageEntry) => [
			packageEntry.name,
			`file:/tmp/${packageEntry.overlayFileName}`,
		]),
	);
	return `${JSON.stringify(
		{
			type: 'module',
			dependencies,
			pnpm: { overrides: dependencies },
		},
		null,
		'\t',
	)}\n`;
}

function renderHermesLocalPackageManifest(
	packageEntries: readonly BetaTarballPackageEntry[],
): string {
	const packageEntryByName = new Map(
		packageEntries.map((packageEntry) => [packageEntry.name, packageEntry]),
	);
	const gatewayRuntimePackage = packageEntryByName.get('@agent-vm/gateway-runtime');
	if (gatewayRuntimePackage === undefined) {
		throw new Error('Hermes image package plan must include @agent-vm/gateway-runtime.');
	}
	const localPackageSpecifiers = Object.fromEntries(
		packageEntries.map((packageEntry) => [
			packageEntry.name,
			`file:./${packageEntry.overlayFileName}`,
		]),
	);
	return `${JSON.stringify(
		{
			type: 'module',
			dependencies: {
				'@agent-vm/gateway-runtime': localPackageSpecifiers['@agent-vm/gateway-runtime'],
			},
			pnpm: { overrides: localPackageSpecifiers },
		},
		null,
		'\t',
	)}\n`;
}

function renderLocalPackageCopyEntries(
	existingCopyEntries: readonly OverlayCopyEntry[] | undefined,
	packageEntries: readonly BetaTarballPackageEntry[],
): readonly OverlayCopyEntry[] {
	return [
		...(existingCopyEntries ?? []).filter((copyEntry) => !isAgentVmLocalCopyEntry(copyEntry)),
		...packageEntries.map((packageEntry) => ({
			from: `local-agent-vm/${packageEntry.overlayFileName}`,
			to: `/tmp/${packageEntry.overlayFileName}`,
		})),
	];
}

function renderLocalPackageTarballPaths(
	packageEntries: readonly BetaTarballPackageEntry[],
): readonly string[] {
	return packageEntries.map((packageEntry) => `/tmp/${packageEntry.overlayFileName}`);
}

function renderLocalPackageInstallStartCommands(
	packageEntries: readonly BetaTarballPackageEntry[],
): readonly string[] {
	const localPackageManifest = renderLocalPackageManifest(packageEntries);
	return [
		'mkdir -p /opt/agent-vm/local-packages',
		`cat > /opt/agent-vm/local-packages/package.json <<'JSON'\n${localPackageManifest}JSON`,
		'cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts',
	];
}

function renderLocalPackageCleanupCommand(
	packageEntries: readonly BetaTarballPackageEntry[],
): string {
	const cleanupPaths = renderLocalPackageTarballPaths(packageEntries);
	return `rm -f ${cleanupPaths.join(' ')}`;
}

export function renderToolVmOverlay(options: RenderToolVmOverlayOptions): ManagedImageOverlay {
	const copyEntries = renderLocalPackageCopyEntries(
		options.existingOverlay.copy,
		options.plan.toolVmPackages,
	);
	const runAfterBase = [
		...(options.existingOverlay.runAfterBase ?? []).filter(
			(command) => !isAgentVmLocalInstallCommand(command),
		),
		...renderLocalPackageInstallStartCommands(options.plan.toolVmPackages),
		'package_root="$(pnpm root -g)" && mkdir -p "$package_root/@agent-vm" && ln -sfn /opt/agent-vm/local-packages/node_modules/@agent-vm/mcp-portal "$package_root/@agent-vm/mcp-portal" && ln -sfn /opt/agent-vm/local-packages/node_modules/.bin/mcp-portal /pnpm/mcp-portal',
		renderLocalPackageCleanupCommand(options.plan.toolVmPackages),
	];
	return {
		...options.existingOverlay,
		copy: copyEntries,
		runAfterBase,
	};
}

async function readJsonFile(filePath: string): Promise<JsonRecord> {
	const fileText = await readFile(filePath, 'utf8');
	const parsedValue: unknown = JSON.parse(stripJsonComments(fileText));
	if (!isJsonRecord(parsedValue)) {
		throw new Error(`${filePath} must contain a JSON object.`);
	}
	return parsedValue;
}

async function writeJsonFile(filePath: string, value: JsonRecord): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`);
}

function readOnlyBuiltDependencies(manifest: JsonRecord): readonly string[] {
	const pnpmConfig = manifest.pnpm;
	if (!isJsonRecord(pnpmConfig) || !Array.isArray(pnpmConfig.onlyBuiltDependencies)) {
		return [];
	}
	return pnpmConfig.onlyBuiltDependencies.filter(
		(value): value is string => typeof value === 'string',
	);
}

async function getGitShortHash(repositoryDirectory: string): Promise<string> {
	const { stdout } = await execFileAsync('git', ['rev-parse', '--short=8', 'HEAD'], {
		cwd: repositoryDirectory,
	});
	return stdout.trim();
}

async function readWorkspacePackageVersion(repositoryDirectory: string): Promise<string> {
	const manifest = await readJsonFile(
		path.join(repositoryDirectory, 'packages', 'agent-vm', 'package.json'),
	);
	const version = manifest.version;
	if (typeof version !== 'string' || version.length === 0) {
		throw new Error('packages/agent-vm/package.json must contain a non-empty version.');
	}
	return version;
}

async function readHermesBetaImageBuildTarget(
	deploymentDirectory: string,
): Promise<HermesManagedImageBuildTarget | undefined> {
	const buildConfigPath = path.join(
		deploymentDirectory,
		'vm-images',
		'gateways',
		'hermes',
		'build-config.jsonc',
	);
	let buildConfig: JsonRecord;
	try {
		buildConfig = await readJsonFile(buildConfigPath);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	const architecture = buildConfig.arch;
	const oci = buildConfig.oci;
	const rootfs = buildConfig.rootfs;
	if (
		(architecture !== 'aarch64' && architecture !== 'x86_64') ||
		!isJsonRecord(oci) ||
		typeof oci.image !== 'string' ||
		oci.image.trim().length === 0 ||
		!isJsonRecord(rootfs) ||
		typeof rootfs.sizeMb !== 'number' ||
		!Number.isSafeInteger(rootfs.sizeMb) ||
		rootfs.sizeMb <= 0
	) {
		throw new Error(
			`${buildConfigPath} must declare arch, oci.image, and a positive integer rootfs.sizeMb for Hermes image synchronization.`,
		);
	}
	return {
		architecture,
		kind: 'gondolin-custom-dockerfile',
		ociImage: oci.image,
		rootfsSizeMb: rootfs.sizeMb,
	};
}

async function resolveHermesBetaImageArtifacts(options: {
	readonly buildTarget: HermesManagedImageBuildTarget;
	readonly repositoryDirectory: string;
	readonly version: string;
}): Promise<HermesBetaImageArtifacts> {
	const agentPortalSdkFileName = `agent_vm_agent_portal_sdk-${options.version}-py3-none-any.whl`;
	const hermesAdapterFileName = `agent_vm_hermes_adapter-${options.version}-py3-none-any.whl`;
	const agentPortalSdkSourcePath = path.join(
		options.repositoryDirectory,
		'dist',
		agentPortalSdkFileName,
	);
	const hermesAdapterSourcePath = path.join(
		options.repositoryDirectory,
		'dist',
		hermesAdapterFileName,
	);
	await Promise.all([access(agentPortalSdkSourcePath), access(hermesAdapterSourcePath)]);
	return {
		buildTarget: options.buildTarget,
		pythonWheels: {
			agentPortalSdk: {
				fileName: agentPortalSdkFileName,
				sourcePath: agentPortalSdkSourcePath,
			},
			hermesAdapter: {
				fileName: hermesAdapterFileName,
				sourcePath: hermesAdapterSourcePath,
			},
		},
	};
}

async function runCommand(
	command: string,
	args: readonly string[],
	options: RunCommandOptions,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const childProcess = spawn(command, [...args], {
			cwd: options.cwd,
			env:
				options.environment === undefined
					? process.env
					: { ...process.env, ...options.environment },
			stdio: 'inherit',
		});
		childProcess.once('error', reject);
		childProcess.once('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'unknown'}.`));
		});
	});
}

async function packPackage(
	packageEntry: BetaTarballPackageEntry,
	options: { readonly repositoryDirectory: string; readonly tarballDirectory: string },
): Promise<void> {
	await execFileAsync(
		'pnpm',
		[
			...resolvePnpmPackArgs({
				packageName: packageEntry.name,
				tarballDirectory: options.tarballDirectory,
			}),
		],
		{
			cwd: options.repositoryDirectory,
			maxBuffer: 20 * 1024 * 1024,
		},
	);
	process.stdout.write(
		`[dev:sync-tarballs] packed ${packageEntry.name} -> ${packageEntry.fileName}\n`,
	);
}

async function copyOverlayPackageTarballs(options: {
	readonly overlayDirectory: string;
	readonly packageEntries: readonly BetaTarballPackageEntry[];
	readonly tarballDirectory: string;
}): Promise<void> {
	const localAgentVmDirectory = path.join(options.overlayDirectory, 'local-agent-vm');
	await mkdir(localAgentVmDirectory, { recursive: true });
	await Promise.all(
		options.packageEntries.map((packageEntry) =>
			cp(
				path.join(options.tarballDirectory, packageEntry.fileName),
				path.join(localAgentVmDirectory, packageEntry.overlayFileName),
			),
		),
	);
}

async function pruneStaleLocalOverlayFiles(options: {
	readonly overlayDirectory: string;
	readonly additionalCurrentFileNames?: readonly string[];
	readonly packageEntries: readonly BetaTarballPackageEntry[];
}): Promise<void> {
	const localAgentVmDirectory = path.join(options.overlayDirectory, 'local-agent-vm');
	let existingDirectoryEntries;
	try {
		existingDirectoryEntries = await readdir(localAgentVmDirectory, { withFileTypes: true });
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	const staleFileNames = listStaleLocalOverlayFileNames({
		...(options.additionalCurrentFileNames
			? { additionalCurrentFileNames: options.additionalCurrentFileNames }
			: {}),
		existingFileNames: existingDirectoryEntries
			.filter((directoryEntry) => directoryEntry.isFile())
			.map((directoryEntry) => directoryEntry.name),
		packageEntries: options.packageEntries,
	});
	await Promise.all(
		staleFileNames.map((fileName) => unlink(path.join(localAgentVmDirectory, fileName))),
	);
}

function isHermesLocalArtifactFileName(
	fileName: string,
	packageEntries: readonly BetaTarballPackageEntry[],
): boolean {
	const isKnownPackageTarball = packageEntries.some((packageEntry) => {
		const packageFileNamePrefix = `${packageEntry.name.replace('@agent-vm/', 'agent-vm-')}-`;
		return fileName.startsWith(packageFileNamePrefix) && fileName.endsWith('.tgz');
	});
	return (
		isKnownPackageTarball ||
		(fileName.startsWith('agent_vm_agent_portal_sdk-') && fileName.endsWith('.whl')) ||
		(fileName.startsWith('agent_vm_hermes_adapter-') && fileName.endsWith('.whl'))
	);
}

async function materializeHermesBetaImageArtifacts(options: {
	readonly deploymentDirectory: string;
	readonly hermesImage: HermesBetaImageArtifacts;
	readonly packageEntries: readonly BetaTarballPackageEntry[];
	readonly tarballDirectory: string;
}): Promise<void> {
	const hermesImageDirectory = path.join(
		options.deploymentDirectory,
		'vm-images',
		'gateways',
		'hermes',
	);
	const localArtifactDirectory = path.join(hermesImageDirectory, 'local-agent-vm');
	await mkdir(localArtifactDirectory, { recursive: true });

	const currentArtifactFileNames = new Set([
		'package.json',
		...options.packageEntries.map((packageEntry) => packageEntry.overlayFileName),
		options.hermesImage.pythonWheels.agentPortalSdk.fileName,
		options.hermesImage.pythonWheels.hermesAdapter.fileName,
	]);
	const existingArtifactEntries = await readdir(localArtifactDirectory, { withFileTypes: true });
	await Promise.all(
		existingArtifactEntries
			.filter(
				(directoryEntry) =>
					directoryEntry.isFile() &&
					isHermesLocalArtifactFileName(directoryEntry.name, options.packageEntries) &&
					!currentArtifactFileNames.has(directoryEntry.name),
			)
			.map((directoryEntry) => unlink(path.join(localArtifactDirectory, directoryEntry.name))),
	);

	await Promise.all([
		...options.packageEntries.map((packageEntry) =>
			cp(
				path.join(options.tarballDirectory, packageEntry.fileName),
				path.join(localArtifactDirectory, packageEntry.overlayFileName),
			),
		),
		cp(
			options.hermesImage.pythonWheels.agentPortalSdk.sourcePath,
			path.join(localArtifactDirectory, options.hermesImage.pythonWheels.agentPortalSdk.fileName),
		),
		cp(
			options.hermesImage.pythonWheels.hermesAdapter.sourcePath,
			path.join(localArtifactDirectory, options.hermesImage.pythonWheels.hermesAdapter.fileName),
		),
	]);
	await writeFile(
		path.join(localArtifactDirectory, 'package.json'),
		renderHermesLocalPackageManifest(options.packageEntries),
	);

	const recipe = renderHermesManagedImageRecipe({
		artifactContext: {
			kind: 'local-artifact-context',
			gatewayRuntime: {
				executablePath:
					'/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js',
				packageArchiveFiles: options.packageEntries.map(
					(packageEntry) => `local-agent-vm/${packageEntry.overlayFileName}`,
				),
				packageManifestFile: 'local-agent-vm/package.json',
			},
			pythonWheels: {
				agentPortalSdk: `local-agent-vm/${options.hermesImage.pythonWheels.agentPortalSdk.fileName}`,
				hermesAdapter: `local-agent-vm/${options.hermesImage.pythonWheels.hermesAdapter.fileName}`,
			},
		},
		buildTarget: options.hermesImage.buildTarget,
	});
	await Promise.all([
		writeFile(path.join(hermesImageDirectory, 'Dockerfile'), recipe.dockerfile),
		writeJsonFile(path.join(hermesImageDirectory, 'build-config.jsonc'), recipe.buildConfig),
	]);
}

export async function refreshBetaDeploymentTarballArtifacts(
	options: RefreshBetaDeploymentTarballArtifactsOptions,
): Promise<void> {
	const deploymentPackagePath = path.join(options.deploymentDirectory, 'package.json');
	const deploymentPackageManifest = await readJsonFile(deploymentPackagePath);
	const onlyBuiltDependencies = readOnlyBuiltDependencies(deploymentPackageManifest);
	await writeJsonFile(
		deploymentPackagePath,
		updateBetaPackageManifest({ manifest: deploymentPackageManifest, plan: options.plan }),
	);
	await writeFile(
		path.join(options.deploymentDirectory, 'pnpm-workspace.yaml'),
		renderBetaPnpmWorkspace({ onlyBuiltDependencies, plan: options.plan }),
	);
	const toolVmOverlayDirectory = path.join(
		options.deploymentDirectory,
		'vm-images',
		'tool-vms',
		'default',
	);
	const toolVmOverlayPath = path.join(toolVmOverlayDirectory, 'overlay.jsonc');
	await copyOverlayPackageTarballs({
		overlayDirectory: toolVmOverlayDirectory,
		packageEntries: options.plan.toolVmPackages,
		tarballDirectory: options.tarballDirectory,
	});
	await pruneStaleLocalOverlayFiles({
		overlayDirectory: toolVmOverlayDirectory,
		packageEntries: options.plan.toolVmPackages,
	});
	const toolVmOverlay = (await readJsonFile(toolVmOverlayPath)) as ManagedImageOverlay;
	await writeJsonFile(
		toolVmOverlayPath,
		renderToolVmOverlay({
			existingOverlay: toolVmOverlay,
			plan: options.plan,
		}),
	);
	if (options.hermesImage !== undefined) {
		await materializeHermesBetaImageArtifacts({
			deploymentDirectory: options.deploymentDirectory,
			hermesImage: options.hermesImage,
			packageEntries: options.plan.hermesGatewayPackages,
			tarballDirectory: options.tarballDirectory,
		});
	}
}

async function syncBetaTarballs(options: SyncBetaTarballsOptions): Promise<void> {
	const hash = options.hash ?? (await getGitShortHash(options.repositoryDirectory));
	const version = await readWorkspacePackageVersion(options.repositoryDirectory);
	const hermesImageBuildTarget = await readHermesBetaImageBuildTarget(options.deploymentDirectory);
	const tarballDirectory = path.join(options.repositoryDirectory, 'tmp', `beta-tarballs-${hash}`);
	const tarballDirectoryReference = path.relative(options.deploymentDirectory, tarballDirectory);
	const plan = createBetaTarballSyncPlan({ cacheKey: hash, tarballDirectoryReference, version });

	if (!options.skipBuild) {
		await runCommand('pnpm', ['build'], { cwd: options.repositoryDirectory });
		if (hermesImageBuildTarget !== undefined) {
			await runCommand('pnpm', ['python:build'], { cwd: options.repositoryDirectory });
		}
	}
	await mkdir(tarballDirectory, { recursive: true });
	for (const packageEntry of plan.packages) {
		// oxlint-disable-next-line no-await-in-loop -- keep pnpm pack output deterministic and fail at the package that broke.
		await packPackage(packageEntry, {
			repositoryDirectory: options.repositoryDirectory,
			tarballDirectory,
		});
	}
	const hermesImage =
		hermesImageBuildTarget === undefined
			? undefined
			: await resolveHermesBetaImageArtifacts({
					buildTarget: hermesImageBuildTarget,
					repositoryDirectory: options.repositoryDirectory,
					version,
				});

	await refreshBetaDeploymentTarballArtifacts({
		deploymentDirectory: options.deploymentDirectory,
		...(hermesImage === undefined ? {} : { hermesImage }),
		plan,
		tarballDirectory,
	});
	if (!options.skipInstall) {
		await runCommand('pnpm', resolveBetaPnpmInstallArgs(), {
			cwd: options.deploymentDirectory,
			environment: resolveBetaPnpmInstallEnvironment(),
		});
	}
}

export function parseCliOptions(args: readonly string[]): SyncBetaTarballsOptions {
	let deploymentDirectory: string | undefined;
	let hash: string | undefined;
	let skipBuild = false;
	let skipInstall = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--') {
			continue;
		}
		if (arg === '--deployment') {
			deploymentDirectory = args[index + 1];
			index += 1;
			continue;
		}
		if (arg === '--hash') {
			hash = args[index + 1];
			index += 1;
			continue;
		}
		if (arg === '--skip-build') {
			skipBuild = true;
			continue;
		}
		if (arg === '--skip-install') {
			skipInstall = true;
			continue;
		}
		throw new Error(`Unknown argument '${arg}'.`);
	}
	if (!deploymentDirectory) {
		throw new Error(
			'Usage: tsx scripts/sync-local-tarballs-to-deployment.ts --deployment <deployment-directory>',
		);
	}
	return {
		deploymentDirectory: path.resolve(deploymentDirectory),
		hash,
		repositoryDirectory: process.cwd(),
		skipBuild,
		skipInstall,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	syncBetaTarballs(parseCliOptions(process.argv.slice(2))).catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
