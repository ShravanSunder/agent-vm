import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const requiredAffectedPackageNames = [
	'@agent-vm/managed-vm',
	'@agent-vm/gateway-lifecycle',
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/openclaw-gateway',
	'@agent-vm/worker-gateway',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/agent-vm',
] as const;

const closureSeedPackageNames = [
	'@agent-vm/managed-vm',
	'@agent-vm/gateway-lifecycle',
	'@agent-vm/gondolin-vm-adapter',
] as const;

const removedNames = ['@agent-vm/gateway-interface', '@agent-vm/gondolin-adapter'] as const;
const forbiddenDeclarationFragments = [
	'@earendil-works/gondolin',
	'Gondolin',
	'ManagedVmInstance',
	'getVmInstance',
	'nativeOptions',
	'backendData',
] as const;

const publishedDependencySections = [
	'dependencies',
	'optionalDependencies',
	'peerDependencies',
] as const;

type JsonRecord = Record<string, unknown>;

export interface WorkspacePackageManifest {
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly name: string;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly private?: boolean;
	readonly version: string;
}

export interface WorkspacePackage {
	readonly directory: string;
	readonly manifest: WorkspacePackageManifest;
}

export interface PackedPackageInput {
	readonly manifest: WorkspacePackageManifest;
	readonly members: ReadonlyMap<string, Uint8Array>;
	readonly tarballName: string;
}

export interface PackedSiblingDependencyReceipt {
	readonly name: string;
	readonly section: string;
	readonly version: string;
}

export interface PackedPackageReceipt {
	readonly declarationMembers: readonly string[];
	readonly members: readonly PackedTarMemberReceipt[];
	readonly memberCount: number;
	readonly name: string;
	readonly siblingDependencies: readonly PackedSiblingDependencyReceipt[];
	readonly tarballName: string;
	readonly tarballSha256: string;
	readonly version: string;
}

export interface PackedTarMemberReceipt {
	readonly name: string;
	readonly sha256: string;
	readonly size: number;
}

export interface BuildArtifactRecord {
	readonly modifiedAtMilliseconds: number;
	readonly path: string;
}

export interface ManagedVmPackageCutReceipt {
	readonly affectedPackages: readonly string[];
	readonly build: {
		readonly completedAt: string;
		readonly head: string;
		readonly startedAt: string;
	};
	readonly head: string;
	readonly packages: readonly PackedPackageReceipt[];
	readonly schemaVersion: 1;
}

export interface InspectManagedVmPackageCutOptions {
	readonly expectedHead: string;
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringMap(value: unknown, fieldName: string): Readonly<Record<string, string>> {
	if (value === undefined) return {};
	if (!isJsonRecord(value)) throw new Error(`${fieldName} must be an object.`);
	const entries: [string, string][] = [];
	for (const [name, version] of Object.entries(value)) {
		if (typeof version !== 'string') throw new Error(`${fieldName}.${name} must be a string.`);
		entries.push([name, version]);
	}
	return Object.fromEntries(entries);
}

export function parseWorkspacePackageManifest(
	manifestText: string,
	manifestPath: string,
): WorkspacePackageManifest {
	const parsed: unknown = JSON.parse(manifestText);
	if (
		!isJsonRecord(parsed) ||
		typeof parsed.name !== 'string' ||
		parsed.name.length === 0 ||
		typeof parsed.version !== 'string' ||
		parsed.version.length === 0
	) {
		throw new Error(`${manifestPath} must contain non-empty name and version fields.`);
	}
	return {
		dependencies: parseStringMap(parsed.dependencies, `${manifestPath} dependencies`),
		devDependencies: parseStringMap(parsed.devDependencies, `${manifestPath} devDependencies`),
		name: parsed.name,
		optionalDependencies: parseStringMap(
			parsed.optionalDependencies,
			`${manifestPath} optionalDependencies`,
		),
		peerDependencies: parseStringMap(parsed.peerDependencies, `${manifestPath} peerDependencies`),
		private: parsed.private === true,
		version: parsed.version,
	};
}

function allDependencyNames(manifest: WorkspacePackageManifest): readonly string[] {
	return [
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	];
}

export function deriveAffectedPublishableClosure(
	workspacePackages: readonly WorkspacePackage[],
): readonly WorkspacePackage[] {
	const packagesByName = new Map(
		workspacePackages.map((workspacePackage) => [workspacePackage.manifest.name, workspacePackage]),
	);
	for (const requiredName of requiredAffectedPackageNames) {
		const requiredPackage = packagesByName.get(requiredName);
		if (requiredPackage === undefined || requiredPackage.manifest.private === true) {
			throw new Error(`Affected publishable package closure is missing ${requiredName}.`);
		}
	}

	const affectedNames = new Set<string>(closureSeedPackageNames);
	let changed = true;
	while (changed) {
		changed = false;
		for (const workspacePackage of workspacePackages) {
			if (workspacePackage.manifest.private === true) continue;
			const workspaceDependencies = allDependencyNames(workspacePackage.manifest).filter((name) =>
				packagesByName.has(name),
			);
			if (
				affectedNames.has(workspacePackage.manifest.name) ||
				workspaceDependencies.some((dependencyName) => affectedNames.has(dependencyName))
			) {
				if (!affectedNames.has(workspacePackage.manifest.name)) changed = true;
				affectedNames.add(workspacePackage.manifest.name);
				for (const dependencyName of workspaceDependencies) {
					if (!affectedNames.has(dependencyName)) changed = true;
					affectedNames.add(dependencyName);
				}
			}
		}
	}

	for (const requiredName of requiredAffectedPackageNames) {
		if (!affectedNames.has(requiredName)) {
			throw new Error(`Derived affected package closure omitted required member ${requiredName}.`);
		}
	}
	return [...affectedNames]
		.map((name) => packagesByName.get(name))
		.filter(
			(workspacePackage): workspacePackage is WorkspacePackage => workspacePackage !== undefined,
		)
		.toSorted((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export function parseInspectManagedVmPackageCutArgs(
	args: readonly string[],
): InspectManagedVmPackageCutOptions {
	if (args.length !== 2 || args[0] !== '--expected-head' || !args[1]) {
		throw new Error(
			'Usage: tsx scripts/inspect-managed-vm-package-cut.ts --expected-head <full-git-head>',
		);
	}
	return { expectedHead: args[1] };
}

export function assertExpectedHead(expectedHead: string, actualHead: string): void {
	if (expectedHead !== actualHead) {
		throw new Error(
			`Expected package inspection HEAD ${expectedHead}, but current HEAD is ${actualHead}.`,
		);
	}
}

export function validateTarMemberNames(memberNames: readonly string[], packageName: string): void {
	if (memberNames.length === 0) throw new Error(`${packageName} tarball is empty.`);
	const uniqueNames = new Set<string>();
	for (const memberName of memberNames) {
		if (
			memberName.includes('\\') ||
			path.posix.isAbsolute(memberName) ||
			memberName !== path.posix.normalize(memberName) ||
			!memberName.startsWith('package/') ||
			memberName.split('/').includes('..')
		) {
			throw new Error(`${packageName} contains unsafe tar member '${memberName}'.`);
		}
		if (uniqueNames.has(memberName)) {
			throw new Error(`${packageName} contains duplicate tar member '${memberName}'.`);
		}
		uniqueNames.add(memberName);
	}
	if (!uniqueNames.has('package/package.json')) {
		throw new Error(`${packageName} tarball is missing package/package.json.`);
	}
}

function decodeText(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function buildPackedTarMemberReceipts(
	members: ReadonlyMap<string, Uint8Array>,
): readonly PackedTarMemberReceipt[] {
	return [...members.entries()]
		.map(
			([name, content]): PackedTarMemberReceipt => ({
				name,
				sha256: sha256Bytes(content),
				size: content.byteLength,
			}),
		)
		.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function assertFreshBuildArtifacts(
	packageName: string,
	buildStartedAtMilliseconds: number,
	artifacts: readonly BuildArtifactRecord[],
): void {
	if (artifacts.length === 0) {
		throw new Error(`${packageName} clean build emitted no dist artifacts.`);
	}
	for (const artifact of artifacts) {
		if (artifact.modifiedAtMilliseconds < buildStartedAtMilliseconds) {
			throw new Error(
				`${packageName} dist artifact ${artifact.path} predates the exact-HEAD clean build.`,
			);
		}
	}
}

function validateNoRemovedNames(
	packageName: string,
	members: ReadonlyMap<string, Uint8Array>,
): void {
	for (const [memberName, content] of members) {
		const memberText = decodeText(content);
		for (const removedName of removedNames) {
			if (memberName.includes(removedName) || memberText.includes(removedName)) {
				throw new Error(
					`${packageName} packed member ${memberName} contains removed name ${removedName}.`,
				);
			}
		}
	}
}

function validateDeclarationMembers(
	packageName: string,
	members: ReadonlyMap<string, Uint8Array>,
): readonly string[] {
	const declarationMembers = [...members.keys()].filter((memberName) =>
		memberName.endsWith('.d.ts'),
	);
	if (declarationMembers.length === 0) {
		throw new Error(`${packageName} tarball contains no public declarations.`);
	}
	if (packageName !== '@agent-vm/gondolin-vm-adapter') {
		for (const memberName of declarationMembers) {
			const declarationText = decodeText(members.get(memberName) ?? new Uint8Array());
			for (const forbiddenFragment of forbiddenDeclarationFragments) {
				if (declarationText.includes(forbiddenFragment)) {
					throw new Error(
						`${packageName} declaration ${memberName} leaks forbidden fragment ${forbiddenFragment}.`,
					);
				}
			}
		}
	}
	return declarationMembers.toSorted();
}

function validateManagedImages(
	packageName: string,
	members: ReadonlyMap<string, Uint8Array>,
): void {
	const managedImages = members.get('package/managed-images.json');
	if (packageName !== '@agent-vm/agent-vm') {
		if (managedImages !== undefined) {
			throw new Error(`${packageName} must not ship managed-images.json.`);
		}
		return;
	}
	if (managedImages === undefined) {
		throw new Error('@agent-vm/agent-vm tarball is missing managed-images.json.');
	}
	const managedImageText = decodeText(managedImages);
	JSON.parse(managedImageText);
	if (/@agent-vm\/[a-z0-9-]+@(?:\^|~)?\d/u.test(managedImageText)) {
		throw new Error('managed-images.json must not pin @agent-vm npm package versions.');
	}
}

export function inspectPackedPackage(
	packedPackage: PackedPackageInput,
	closureVersions: ReadonlyMap<string, string>,
): Omit<PackedPackageReceipt, 'tarballSha256'> {
	validateTarMemberNames([...packedPackage.members.keys()], packedPackage.manifest.name);
	const packedManifestBytes = packedPackage.members.get('package/package.json');
	if (packedManifestBytes === undefined) throw new Error('Unreachable missing packed manifest.');
	const packedManifest = parseWorkspacePackageManifest(
		decodeText(packedManifestBytes),
		`${packedPackage.tarballName}:package/package.json`,
	);
	if (
		packedManifest.name !== packedPackage.manifest.name ||
		packedManifest.version !== packedPackage.manifest.version
	) {
		throw new Error(
			`${packedPackage.manifest.name} packed identity drifted to ${packedManifest.name}@${packedManifest.version}.`,
		);
	}

	const siblingDependencies: PackedSiblingDependencyReceipt[] = [];
	const expectedSiblingSections = new Map<string, string>();
	const packedSiblingSections = new Map<string, string>();
	for (const sectionName of publishedDependencySections) {
		for (const dependencyName of Object.keys(packedPackage.manifest[sectionName] ?? {})) {
			if (closureVersions.has(dependencyName)) {
				expectedSiblingSections.set(dependencyName, sectionName);
			}
		}
		const dependencies = packedManifest[sectionName] ?? {};
		for (const [dependencyName, dependencyVersion] of Object.entries(dependencies)) {
			const expectedVersion = closureVersions.get(dependencyName);
			if (expectedVersion === undefined) continue;
			packedSiblingSections.set(dependencyName, sectionName);
			const expectedSection = expectedSiblingSections.get(dependencyName);
			if (expectedSection === undefined) {
				throw new Error(
					`${packedManifest.name} packed manifest contains unexpected sibling edge ${sectionName}.${dependencyName}.`,
				);
			}
			if (expectedSection !== sectionName) {
				throw new Error(
					`${packedManifest.name} sibling ${dependencyName} moved from ${expectedSection} to ${sectionName}.`,
				);
			}
			if (dependencyVersion !== expectedVersion) {
				throw new Error(
					`${packedManifest.name} ${sectionName}.${dependencyName} must equal sibling version ${expectedVersion}, received ${dependencyVersion}.`,
				);
			}
			siblingDependencies.push({
				name: dependencyName,
				section: sectionName,
				version: dependencyVersion,
			});
		}
	}
	for (const [dependencyName, expectedSection] of expectedSiblingSections) {
		if (!packedSiblingSections.has(dependencyName)) {
			throw new Error(
				`${packedManifest.name} packed manifest is missing sibling edge ${expectedSection}.${dependencyName}.`,
			);
		}
	}

	validateNoRemovedNames(packedManifest.name, packedPackage.members);
	const declarationMembers = validateDeclarationMembers(packedManifest.name, packedPackage.members);
	validateManagedImages(packedManifest.name, packedPackage.members);
	return {
		declarationMembers,
		members: buildPackedTarMemberReceipts(packedPackage.members),
		memberCount: packedPackage.members.size,
		name: packedManifest.name,
		siblingDependencies: siblingDependencies.toSorted((left, right) =>
			`${left.section}:${left.name}`.localeCompare(`${right.section}:${right.name}`),
		),
		tarballName: packedPackage.tarballName,
		version: packedManifest.version,
	};
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readWorkspacePackages(
	repositoryRoot: string,
): Promise<readonly WorkspacePackage[]> {
	const packagesDirectory = path.join(repositoryRoot, 'packages');
	const entries = await readdir(packagesDirectory, { withFileTypes: true });
	const packageDirectories = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(packagesDirectory, entry.name));
	const workspacePackages = await Promise.all(
		packageDirectories.map(async (directory): Promise<WorkspacePackage | undefined> => {
			const manifestPath = path.join(directory, 'package.json');
			try {
				return {
					directory,
					manifest: parseWorkspacePackageManifest(
						await readFile(manifestPath, 'utf8'),
						manifestPath,
					),
				};
			} catch (error: unknown) {
				if (isFileNotFoundError(error)) return undefined;
				throw error;
			}
		}),
	);
	return workspacePackages.filter(
		(workspacePackage): workspacePackage is WorkspacePackage => workspacePackage !== undefined,
	);
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(command, [...args], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout.trim();
}

async function assertCleanHeadWorktree(repositoryRoot: string): Promise<void> {
	const status = await runCommand(
		'git',
		['status', '--porcelain=v1', '--untracked-files=all'],
		repositoryRoot,
	);
	if (status.length > 0) {
		throw new Error(`Exact-HEAD package inspection requires a clean worktree; found:\n${status}`);
	}
}

export async function prepareCleanBuildDirectories(
	workspacePackages: readonly WorkspacePackage[],
): Promise<void> {
	await Promise.all(
		workspacePackages.map(async (workspacePackage): Promise<void> => {
			await rm(path.join(workspacePackage.directory, 'dist'), { force: true, recursive: true });
		}),
	);
}

async function listBuildArtifactRecords(
	directory: string,
): Promise<readonly BuildArtifactRecord[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nestedRecords = await Promise.all(
		entries.map(async (entry): Promise<readonly BuildArtifactRecord[]> => {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) return await listBuildArtifactRecords(entryPath);
			if (!entry.isFile()) {
				throw new Error(`Clean build output contains unsupported non-file artifact ${entryPath}.`);
			}
			const artifactStats = await stat(entryPath);
			return [{ modifiedAtMilliseconds: artifactStats.mtimeMs, path: entryPath }];
		}),
	);
	return nestedRecords.flat();
}

async function assertFreshWorkspaceBuildArtifacts(
	workspacePackages: readonly WorkspacePackage[],
	buildStartedAtMilliseconds: number,
): Promise<void> {
	await Promise.all(
		workspacePackages.map(async (workspacePackage): Promise<void> => {
			const distDirectory = path.join(workspacePackage.directory, 'dist');
			assertFreshBuildArtifacts(
				workspacePackage.manifest.name,
				buildStartedAtMilliseconds,
				await listBuildArtifactRecords(distDirectory),
			);
		}),
	);
}

async function packWorkspacePackage(
	workspacePackage: WorkspacePackage,
	temporaryDirectory: string,
): Promise<string> {
	const packageOutputDirectory = path.join(
		temporaryDirectory,
		workspacePackage.manifest.name.replaceAll('/', '__'),
	);
	await mkdir(packageOutputDirectory);
	await runCommand(
		'pnpm',
		[
			'--config.ignore-scripts=true',
			'--dir',
			workspacePackage.directory,
			'pack',
			'--pack-destination',
			packageOutputDirectory,
		],
		workspacePackage.directory,
	);
	const createdTarballs = (await readdir(packageOutputDirectory)).filter((fileName) =>
		fileName.endsWith('.tgz'),
	);
	if (createdTarballs.length !== 1) {
		throw new Error(
			`${workspacePackage.manifest.name} pack created ${createdTarballs.length} tarballs; expected exactly one.`,
		);
	}
	return path.join(packageOutputDirectory, createdTarballs[0]);
}

async function readTarballMembers(
	tarballPath: string,
	packageName: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
	const memberOutput = await runCommand('tar', ['-tzf', tarballPath], path.dirname(tarballPath));
	const memberNames = memberOutput.split('\n').filter((memberName) => memberName.length > 0);
	validateTarMemberNames(memberNames, packageName);
	const memberEntries = await Promise.all(
		memberNames.map(async (memberName): Promise<readonly [string, Uint8Array]> => {
			const { stdout } = await execFileAsync('tar', ['-xOzf', tarballPath, memberName], {
				cwd: path.dirname(tarballPath),
				encoding: 'buffer',
				maxBuffer: 64 * 1024 * 1024,
			});
			return [memberName, new Uint8Array(stdout)];
		}),
	);
	return new Map(memberEntries);
}

async function sha256File(filePath: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(filePath))
		.digest('hex');
}

export async function inspectManagedVmPackageCut(
	options: InspectManagedVmPackageCutOptions,
): Promise<ManagedVmPackageCutReceipt> {
	const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const initialHead = await runCommand('git', ['rev-parse', 'HEAD'], repositoryRoot);
	assertExpectedHead(options.expectedHead, initialHead);
	await assertCleanHeadWorktree(repositoryRoot);

	const affectedPackages = deriveAffectedPublishableClosure(
		await readWorkspacePackages(repositoryRoot),
	);
	const buildStartedAtMilliseconds = Date.now();
	const buildStartedAt = new Date(buildStartedAtMilliseconds).toISOString();
	await prepareCleanBuildDirectories(affectedPackages);
	await runCommand('pnpm', ['build'], repositoryRoot);
	const buildCompletedAt = new Date().toISOString();
	await assertFreshWorkspaceBuildArtifacts(affectedPackages, buildStartedAtMilliseconds);
	const postBuildHead = await runCommand('git', ['rev-parse', 'HEAD'], repositoryRoot);
	assertExpectedHead(initialHead, postBuildHead);
	await assertCleanHeadWorktree(repositoryRoot);

	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-package-cut-'));
	try {
		const closureVersions = new Map(
			affectedPackages.map((workspacePackage) => [
				workspacePackage.manifest.name,
				workspacePackage.manifest.version,
			]),
		);
		const packageReceipts = await Promise.all(
			affectedPackages.map(async (workspacePackage): Promise<PackedPackageReceipt> => {
				const tarballPath = await packWorkspacePackage(workspacePackage, temporaryDirectory);
				const packedAtStats = await stat(tarballPath);
				if (packedAtStats.mtimeMs < buildStartedAtMilliseconds) {
					throw new Error(
						`${workspacePackage.manifest.name} tarball predates the exact-HEAD clean build.`,
					);
				}
				const inspectedPackage = inspectPackedPackage(
					{
						manifest: workspacePackage.manifest,
						members: await readTarballMembers(tarballPath, workspacePackage.manifest.name),
						tarballName: path.basename(tarballPath),
					},
					closureVersions,
				);
				await chmod(tarballPath, 0o444);
				const tarballStats = await stat(tarballPath);
				if ((tarballStats.mode & 0o222) !== 0) {
					throw new Error(`${workspacePackage.manifest.name} packed artifact is not read-only.`);
				}
				return {
					...inspectedPackage,
					tarballSha256: await sha256File(tarballPath),
				};
			}),
		);
		return {
			affectedPackages: affectedPackages.map((workspacePackage) => workspacePackage.manifest.name),
			build: { completedAt: buildCompletedAt, head: initialHead, startedAt: buildStartedAt },
			head: initialHead,
			packages: packageReceipts,
			schemaVersion: 1,
		};
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

async function main(): Promise<void> {
	const receipt = await inspectManagedVmPackageCut(
		parseInspectManagedVmPackageCutArgs(process.argv.slice(2)),
	);
	process.stdout.write(`${JSON.stringify(receipt, undefined, 2)}\n`);
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedScriptPath === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
