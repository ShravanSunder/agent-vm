import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	type PackageOverrides,
	emptyPackageOverrides,
	packageOverridesSchema,
} from '../packages/agent-vm/src/build/package-overrides.ts';
import { stripJsonComments } from './jsonc-comments.ts';

const execFileAsync = promisify(execFile);

export const AGENT_VM_PACKAGE_NAMES = [
	'@agent-vm/agent-vm',
	'@agent-vm/agent-vm-worker',
	'@agent-vm/config-contracts',
	'@agent-vm/gateway-interface',
	'@agent-vm/gondolin-adapter',
	'@agent-vm/mcp-portal',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/openclaw-gateway',
	'@agent-vm/openclaw-mcp-portal-plugin',
	'@agent-vm/secret-management',
	'@agent-vm/worker-gateway',
] as const;

export const OPENCLAW_GATEWAY_TARBALL_PACKAGE_NAMES = [
	'@agent-vm/config-contracts',
	'@agent-vm/secret-management',
	'@agent-vm/gondolin-adapter',
	'@agent-vm/gateway-interface',
	'@agent-vm/mcp-portal',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/openclaw-mcp-portal-plugin',
] as const;

export const TOOL_VM_TARBALL_PACKAGE_NAMES = [
	'@agent-vm/config-contracts',
	'@agent-vm/secret-management',
	'@agent-vm/mcp-portal',
] as const;

type AgentVmPackageName = (typeof AGENT_VM_PACKAGE_NAMES)[number];

interface BetaTarballPackageEntry {
	readonly fileName: string;
	readonly name: AgentVmPackageName;
	readonly overlayFileName: string;
	readonly specifier: string;
}

export interface BetaTarballSyncPlan {
	readonly gatewayPackages: readonly BetaTarballPackageEntry[];
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

interface OpenClawGatewayOverlay {
	readonly copy?: readonly OverlayCopyEntry[];
	readonly extraAptPackages?: readonly string[];
	readonly extraOpenClawPackages?: readonly string[];
	readonly openClawPackageOverrides?: readonly string[];
	readonly packageOverrides?: PackageOverrides;
	readonly pnpmOverrides?: Record<string, string>;
	readonly runAfterBase?: readonly string[];
	readonly [key: string]: unknown;
}

interface RenderOpenClawGatewayOverlayOptions {
	readonly existingOverlay: OpenClawGatewayOverlay;
	readonly managedPackageOverrides?: PackageOverrides;
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
	const gatewayPackages = OPENCLAW_GATEWAY_TARBALL_PACKAGE_NAMES.map((packageName) => {
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
		gatewayPackages,
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
	return `rm -f ${renderLocalPackageTarballPaths(packageEntries).join(' ')}`;
}

interface ParsedPackageSpec {
	readonly name: string;
	readonly version?: string;
}

function parsePackageSpec(packageSpec: string): ParsedPackageSpec {
	if (packageSpec.startsWith('@')) {
		const scopeSeparatorIndex = packageSpec.indexOf('/');
		if (scopeSeparatorIndex === -1) {
			return { name: packageSpec };
		}
		const versionSeparatorIndex = packageSpec.indexOf('@', scopeSeparatorIndex + 1);
		if (versionSeparatorIndex === -1) {
			return { name: packageSpec };
		}
		return {
			name: packageSpec.slice(0, versionSeparatorIndex),
			version: packageSpec.slice(versionSeparatorIndex + 1),
		};
	}

	const versionSeparatorIndex = packageSpec.indexOf('@');
	if (versionSeparatorIndex === -1) {
		return { name: packageSpec };
	}
	return {
		name: packageSpec.slice(0, versionSeparatorIndex),
		version: packageSpec.slice(versionSeparatorIndex + 1),
	};
}

function specName(packageSpec: string): string {
	return parsePackageSpec(packageSpec).name;
}

function pruneSpecBucket(
	overlaySpecs: readonly string[],
	managedSpecs: readonly string[],
): readonly string[] {
	const managedByName = new Map(
		managedSpecs.map((packageSpec) => [specName(packageSpec), packageSpec]),
	);
	return overlaySpecs.filter(
		(packageSpec) => managedByName.get(specName(packageSpec)) !== packageSpec,
	);
}

function prunePnpmBucket(
	overlayPnpm: Readonly<Record<string, string>>,
	managedPnpm: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(overlayPnpm).filter(
			([packageName, version]) => managedPnpm[packageName] !== version,
		),
	);
}

function compactPackageOverrides(packageOverrides: PackageOverrides): PackageOverrides | undefined {
	const compacted: PackageOverrides = {
		npm: packageOverrides.npm,
		openclaw: packageOverrides.openclaw,
		pnpm: packageOverrides.pnpm,
	};
	if (
		compacted.npm.length === 0 &&
		compacted.openclaw.length === 0 &&
		Object.keys(compacted.pnpm).length === 0
	) {
		return undefined;
	}
	return compacted;
}

function assertNoLegacyPackageOverrideKeys(existingOverlay: OpenClawGatewayOverlay): void {
	if (existingOverlay.extraOpenClawPackages !== undefined) {
		throw new Error('move extraOpenClawPackages to packageOverrides.openclaw');
	}
	if (existingOverlay.openClawPackageOverrides !== undefined) {
		throw new Error('move openClawPackageOverrides to packageOverrides.openclaw');
	}
	if (existingOverlay.pnpmOverrides !== undefined) {
		throw new Error('move pnpmOverrides to packageOverrides.pnpm');
	}
}

export function migrateLegacyOpenClawPackageOverrides(
	existingOverlay: OpenClawGatewayOverlay,
	options: { readonly managedPackageOverrides?: PackageOverrides } = {},
): OpenClawGatewayOverlay {
	assertNoLegacyPackageOverrideKeys(existingOverlay);
	const {
		extraOpenClawPackages: _legacyOpenClawPackageOverrides,
		openClawPackageOverrides: _openClawPackageOverrides,
		pnpmOverrides: _stalePnpmOverrides,
		packageOverrides: _packageOverrides,
		...baseOverlay
	} = existingOverlay;
	const parsedPackageOverrides = packageOverridesSchema.parse(
		existingOverlay.packageOverrides ?? emptyPackageOverrides(),
	);
	const managedPackageOverrides = options.managedPackageOverrides ?? emptyPackageOverrides();
	const packageOverrides = compactPackageOverrides({
		npm: pruneSpecBucket(parsedPackageOverrides.npm, managedPackageOverrides.npm),
		openclaw: pruneSpecBucket(parsedPackageOverrides.openclaw, managedPackageOverrides.openclaw),
		pnpm: prunePnpmBucket(parsedPackageOverrides.pnpm, managedPackageOverrides.pnpm),
	});
	return {
		...baseOverlay,
		...(packageOverrides ? { packageOverrides } : {}),
	};
}

export function renderOpenClawGatewayOverlay(
	options: RenderOpenClawGatewayOverlayOptions,
): OpenClawGatewayOverlay {
	const baseOverlay = migrateLegacyOpenClawPackageOverrides(options.existingOverlay, {
		managedPackageOverrides: options.managedPackageOverrides,
	});
	const copyEntries = renderLocalPackageCopyEntries(
		options.existingOverlay.copy,
		options.plan.gatewayPackages,
	);
	const runAfterBase = [
		...(options.existingOverlay.runAfterBase ?? []).filter(
			(command) => !isAgentVmLocalInstallCommand(command),
		),
		...renderLocalPackageInstallStartCommands(options.plan.gatewayPackages),
		'package_root="$(pnpm root -g)" && mkdir -p "$package_root/@agent-vm" && ln -sfn /opt/agent-vm/local-packages/node_modules/@agent-vm/openclaw-agent-vm-plugin "$package_root/@agent-vm/openclaw-agent-vm-plugin" && ln -sfn /opt/agent-vm/local-packages/node_modules/@agent-vm/openclaw-mcp-portal-plugin "$package_root/@agent-vm/openclaw-mcp-portal-plugin" && ln -sfn /opt/agent-vm/local-packages/node_modules/@agent-vm/mcp-portal "$package_root/@agent-vm/mcp-portal"',
		renderLocalPackageCleanupCommand(options.plan.gatewayPackages),
	];
	return {
		...baseOverlay,
		copy: copyEntries,
		runAfterBase,
	};
}

export function renderToolVmOverlay(
	options: RenderOpenClawGatewayOverlayOptions,
): OpenClawGatewayOverlay {
	const baseOverlay = migrateLegacyOpenClawPackageOverrides(options.existingOverlay, {
		managedPackageOverrides: options.managedPackageOverrides,
	});
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
		...baseOverlay,
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

async function listManagedImageOverlayPaths(directoryPath: string): Promise<readonly string[]> {
	let directoryEntries;
	try {
		directoryEntries = await readdir(directoryPath, { withFileTypes: true });
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const nestedOverlayPaths = await Promise.all(
		directoryEntries.map(async (directoryEntry) => {
			const entryPath = path.join(directoryPath, directoryEntry.name);
			if (directoryEntry.isDirectory()) {
				return listManagedImageOverlayPaths(entryPath);
			}
			if (directoryEntry.isFile() && directoryEntry.name === 'overlay.jsonc') {
				return [entryPath];
			}
			return [];
		}),
	);
	return nestedOverlayPaths.flat();
}

async function migrateDeploymentOverlayFieldNames(deploymentDirectory: string): Promise<void> {
	const overlayPaths = await listManagedImageOverlayPaths(
		path.join(deploymentDirectory, 'vm-images'),
	);
	await Promise.all(
		overlayPaths.map(async (overlayPath) => {
			const overlay = (await readJsonFile(overlayPath)) as OpenClawGatewayOverlay;
			if (overlay.extraOpenClawPackages === undefined) {
				return;
			}
			await writeJsonFile(overlayPath, migrateLegacyOpenClawPackageOverrides(overlay));
		}),
	);
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

async function readManagedOpenClawGatewayPackageOverrides(
	repositoryDirectory: string,
): Promise<PackageOverrides> {
	const manifest = await readJsonFile(
		path.join(repositoryDirectory, 'packages', 'agent-vm', 'managed-images.json'),
	);
	const baseImages = manifest.baseImages;
	if (typeof baseImages !== 'object' || baseImages === null || Array.isArray(baseImages)) {
		throw new Error('packages/agent-vm/managed-images.json must contain baseImages.');
	}
	const openClawGateway = (baseImages as JsonRecord)['openclaw-gateway'];
	if (
		typeof openClawGateway !== 'object' ||
		openClawGateway === null ||
		Array.isArray(openClawGateway)
	) {
		throw new Error(
			'packages/agent-vm/managed-images.json must contain baseImages.openclaw-gateway.',
		);
	}
	const parsedPackageOverrides = packageOverridesSchema.safeParse(
		(openClawGateway as JsonRecord).packageOverrides,
	);
	if (!parsedPackageOverrides.success) {
		throw new Error(
			'packages/agent-vm/managed-images.json must contain baseImages.openclaw-gateway.packageOverrides.',
		);
	}
	return parsedPackageOverrides.data;
}

async function runCommand(
	command: string,
	args: readonly string[],
	options: { readonly cwd: string },
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const childProcess = spawn(command, [...args], {
			cwd: options.cwd,
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

async function syncBetaTarballs(options: SyncBetaTarballsOptions): Promise<void> {
	const hash = options.hash ?? (await getGitShortHash(options.repositoryDirectory));
	const version = await readWorkspacePackageVersion(options.repositoryDirectory);
	const managedOpenClawGatewayPackageOverrides = await readManagedOpenClawGatewayPackageOverrides(
		options.repositoryDirectory,
	);
	const tarballDirectory = path.join(options.repositoryDirectory, 'tmp', `beta-tarballs-${hash}`);
	const tarballDirectoryReference = path.relative(options.deploymentDirectory, tarballDirectory);
	const plan = createBetaTarballSyncPlan({ cacheKey: hash, tarballDirectoryReference, version });

	if (!options.skipBuild) {
		await runCommand('pnpm', ['build'], { cwd: options.repositoryDirectory });
	}
	await mkdir(tarballDirectory, { recursive: true });
	for (const packageEntry of plan.packages) {
		// oxlint-disable-next-line no-await-in-loop -- keep pnpm pack output deterministic and fail at the package that broke.
		await packPackage(packageEntry, {
			repositoryDirectory: options.repositoryDirectory,
			tarballDirectory,
		});
	}

	const deploymentPackagePath = path.join(options.deploymentDirectory, 'package.json');
	const deploymentPackageManifest = await readJsonFile(deploymentPackagePath);
	const onlyBuiltDependencies = readOnlyBuiltDependencies(deploymentPackageManifest);
	await writeJsonFile(
		deploymentPackagePath,
		updateBetaPackageManifest({ manifest: deploymentPackageManifest, plan }),
	);
	await writeFile(
		path.join(options.deploymentDirectory, 'pnpm-workspace.yaml'),
		renderBetaPnpmWorkspace({ onlyBuiltDependencies, plan }),
	);
	if (!options.skipInstall) {
		await runCommand('pnpm', ['install'], { cwd: options.deploymentDirectory });
	}
	await migrateDeploymentOverlayFieldNames(options.deploymentDirectory);

	const overlayDirectory = path.join(
		options.deploymentDirectory,
		'vm-images',
		'gateways',
		'openclaw',
	);
	const overlayPath = path.join(overlayDirectory, 'overlay.jsonc');
	await copyOverlayPackageTarballs({
		overlayDirectory,
		packageEntries: plan.gatewayPackages,
		tarballDirectory,
	});
	const overlay = (await readJsonFile(overlayPath)) as OpenClawGatewayOverlay;
	await writeJsonFile(
		overlayPath,
		renderOpenClawGatewayOverlay({
			existingOverlay: overlay,
			managedPackageOverrides: managedOpenClawGatewayPackageOverrides,
			plan,
		}),
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
		packageEntries: plan.toolVmPackages,
		tarballDirectory,
	});
	const toolVmOverlay = (await readJsonFile(toolVmOverlayPath)) as OpenClawGatewayOverlay;
	await writeJsonFile(
		toolVmOverlayPath,
		renderToolVmOverlay({
			existingOverlay: toolVmOverlay,
			managedPackageOverrides: emptyPackageOverrides(),
			plan,
		}),
	);
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
			'Usage: tsx scripts/sync-local-tarballs-to-deployment.ts --deployment ../shravan-claw-beta',
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
