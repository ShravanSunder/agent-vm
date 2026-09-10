import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const packagesDirectory = path.join(repositoryRoot, 'packages');
const stockGondolinPackageName = '@earendil-works/gondolin';
const stockGondolinVersion = '0.12.0';
const maximumConsumerBytes = 2 * 1024 * 1024 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

interface WorkspacePackage {
	readonly directory: string;
	readonly manifest: JsonObject & { readonly name: string; readonly version: string };
}

interface PnpmDependencyRecord {
	readonly dependencies?: Readonly<Record<string, PnpmDependencyRecord>>;
	readonly from?: string;
	readonly path?: string;
	readonly resolved?: string;
	readonly version?: string;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireStringProperty(object: JsonObject, propertyName: string, context: string): string {
	const value = object[propertyName];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${context}.${propertyName} must be a non-empty string.`);
	}
	return value;
}

function dependencyNames(manifest: JsonObject): readonly string[] {
	const names = new Set<string>();
	for (const dependencySection of [
		'dependencies',
		'optionalDependencies',
		'peerDependencies',
	] as const) {
		const dependencies = manifest[dependencySection];
		if (!isJsonObject(dependencies)) continue;
		for (const dependencyName of Object.keys(dependencies)) names.add(dependencyName);
	}
	return [...names];
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
	const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
	if (!isJsonObject(parsed)) throw new Error(`${filePath} must contain a JSON object.`);
	return parsed;
}

async function readWorkspacePackage(directoryName: string): Promise<WorkspacePackage | undefined> {
	const directory = path.join(packagesDirectory, directoryName);
	let manifest: JsonObject;
	try {
		manifest = await readJsonObject(path.join(directory, 'package.json'));
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
	return {
		directory,
		manifest: {
			...manifest,
			name: requireStringProperty(manifest, 'name', directoryName),
			version: requireStringProperty(manifest, 'version', directoryName),
		},
	};
}

async function discoverAgentVmConsumerClosure(): Promise<readonly WorkspacePackage[]> {
	const packageEntries = await readdir(packagesDirectory, { withFileTypes: true });
	const discoveredPackages = await Promise.all(
		packageEntries
			.filter((entry) => entry.isDirectory())
			.map(
				async (entry): Promise<WorkspacePackage | undefined> =>
					await readWorkspacePackage(entry.name),
			),
	);
	const workspacePackages = discoveredPackages.filter(
		(workspacePackage): workspacePackage is WorkspacePackage => workspacePackage !== undefined,
	);
	const packageByName = new Map(
		workspacePackages.map((workspacePackage) => [workspacePackage.manifest.name, workspacePackage]),
	);
	const selectedPackageNames = new Set<string>();
	const pendingPackageNames = ['@agent-vm/agent-vm'];
	while (pendingPackageNames.length > 0) {
		const packageName = pendingPackageNames.shift();
		if (packageName === undefined || selectedPackageNames.has(packageName)) continue;
		const workspacePackage = packageByName.get(packageName);
		if (workspacePackage === undefined) {
			throw new Error(`Workspace package closure is missing ${packageName}.`);
		}
		selectedPackageNames.add(packageName);
		for (const dependencyName of dependencyNames(workspacePackage.manifest)) {
			if (packageByName.has(dependencyName)) pendingPackageNames.push(dependencyName);
		}
	}
	return workspacePackages
		.filter((workspacePackage) => selectedPackageNames.has(workspacePackage.manifest.name))
		.toSorted((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function tarballFileName(workspacePackage: WorkspacePackage): string {
	return `${workspacePackage.manifest.name.replace('@agent-vm/', 'agent-vm-')}-${workspacePackage.manifest.version}.tgz`;
}

function assertPathWithinDirectory(candidatePath: string, parentDirectory: string): void {
	const relativePath = path.relative(parentDirectory, candidatePath);
	expect(relativePath).not.toBe('');
	expect(relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)).toBe(false);
}

async function findPackageDirectory(entryPath: string, expectedName: string): Promise<string> {
	const candidateDirectory = path.dirname(entryPath);
	const manifestPath = path.join(candidateDirectory, 'package.json');
	try {
		const manifest = await readJsonObject(manifestPath);
		if (manifest['name'] === expectedName) return await realpath(candidateDirectory);
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
	}
	const parentDirectory = path.dirname(candidateDirectory);
	if (parentDirectory === candidateDirectory) {
		throw new Error(`Could not find package root for ${expectedName} from ${entryPath}.`);
	}
	return await findPackageDirectory(candidateDirectory, expectedName);
}

async function storedBytes(rootDirectory: string): Promise<number> {
	const rootStat = await stat(rootDirectory);
	if (!rootStat.isDirectory()) return rootStat.size;
	const entries = await readdir(rootDirectory, { withFileTypes: true });
	const entryByteCounts = await Promise.all(
		entries.map(async (entry): Promise<number> => {
			if (entry.isSymbolicLink()) return 0;
			return await storedBytes(path.join(rootDirectory, entry.name));
		}),
	);
	return entryByteCounts.reduce((totalBytes, entryBytes) => totalBytes + entryBytes, 0);
}

function requirePnpmDependency(
	dependencies: Readonly<Record<string, PnpmDependencyRecord>> | undefined,
	dependencyName: string,
): PnpmDependencyRecord {
	const dependency = dependencies?.[dependencyName];
	if (dependency === undefined) throw new Error(`pnpm list omitted ${dependencyName}.`);
	return dependency;
}

function requireWorkspacePackage(
	workspacePackages: readonly WorkspacePackage[],
	packageName: string,
): WorkspacePackage {
	const workspacePackage = workspacePackages.find(
		(candidatePackage) => candidatePackage.manifest.name === packageName,
	);
	if (workspacePackage === undefined) {
		throw new Error(`Packed workspace closure omitted ${packageName}.`);
	}
	return workspacePackage;
}

describe('packed stock Gondolin consumer', () => {
	it('installs the packed agent-vm dependency chain with registry Gondolin and no patch', async () => {
		const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-packed-stock-consumer-'));
		const packDirectory = path.join(fixtureRoot, 'pack');
		const consumerDirectory = path.join(fixtureRoot, 'consumer');
		try {
			await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);
			const workspacePackages = await discoverAgentVmConsumerClosure();
			expect(workspacePackages).toHaveLength(17);
			const agentVmWorkspacePackage = requireWorkspacePackage(
				workspacePackages,
				'@agent-vm/agent-vm',
			);
			const gondolinAdapterWorkspacePackage = requireWorkspacePackage(
				workspacePackages,
				'@agent-vm/gondolin-vm-adapter',
			);
			await Promise.all(
				workspacePackages.map(async (workspacePackage): Promise<void> => {
					await execa(
						'pnpm',
						[
							'--filter',
							workspacePackage.manifest.name,
							'pack',
							'--pack-destination',
							packDirectory,
							'--config.ignore-scripts=true',
						],
						{ cwd: repositoryRoot, timeout: 60_000 },
					);
				}),
			);

			const localPackageSpecifiers = Object.fromEntries(
				workspacePackages.map((workspacePackage) => [
					workspacePackage.manifest.name,
					`file:${path.join(packDirectory, tarballFileName(workspacePackage))}`,
				]),
			);
			expect(localPackageSpecifiers).not.toHaveProperty(stockGondolinPackageName);
			await writeFile(
				path.join(consumerDirectory, 'package.json'),
				`${JSON.stringify(
					{
						dependencies: { '@agent-vm/agent-vm': localPackageSpecifiers['@agent-vm/agent-vm'] },
						name: 'agent-vm-packed-stock-consumer',
						packageManager: 'pnpm@10.33.0',
						pnpm: { overrides: localPackageSpecifiers },
						private: true,
						type: 'module',
					},
					null,
					'\t',
				)}\n`,
				'utf8',
			);

			const installEnvironment = { CI: 'true', PNPM_CONFIG_CONFIRM_MODULES_PURGE: 'false' };
			await execa(
				'pnpm',
				['--dir', consumerDirectory, 'install', '--prefer-offline', '--config.ignore-scripts=true'],
				{ cwd: repositoryRoot, env: installEnvironment, timeout: 300_000 },
			);
			await rm(path.join(consumerDirectory, 'node_modules'), { recursive: true });
			await execa(
				'pnpm',
				[
					'--dir',
					consumerDirectory,
					'install',
					'--frozen-lockfile',
					'--offline',
					'--config.ignore-scripts=true',
				],
				{ cwd: repositoryRoot, env: installEnvironment, timeout: 300_000 },
			);

			const realConsumerDirectory = await realpath(consumerDirectory);
			const agentVmDirectory = await findPackageDirectory(
				fileURLToPath(
					import.meta.resolve(
						'@agent-vm/agent-vm',
						pathToFileURL(path.join(consumerDirectory, 'package.json')),
					),
				),
				'@agent-vm/agent-vm',
			);
			const gondolinAdapterDirectory = await findPackageDirectory(
				fileURLToPath(
					import.meta.resolve(
						'@agent-vm/gondolin-vm-adapter',
						pathToFileURL(path.join(agentVmDirectory, 'package.json')),
					),
				),
				'@agent-vm/gondolin-vm-adapter',
			);
			const gondolinDirectory = await findPackageDirectory(
				fileURLToPath(
					import.meta.resolve(
						stockGondolinPackageName,
						pathToFileURL(path.join(gondolinAdapterDirectory, 'package.json')),
					),
				),
				stockGondolinPackageName,
			);
			for (const resolvedDirectory of [
				agentVmDirectory,
				gondolinAdapterDirectory,
				gondolinDirectory,
			]) {
				assertPathWithinDirectory(resolvedDirectory, realConsumerDirectory);
			}

			const agentVmManifest = await readJsonObject(path.join(agentVmDirectory, 'package.json'));
			const gondolinAdapterManifest = await readJsonObject(
				path.join(gondolinAdapterDirectory, 'package.json'),
			);
			const gondolinManifest = await readJsonObject(path.join(gondolinDirectory, 'package.json'));
			expect(agentVmManifest['version']).toBe(agentVmWorkspacePackage.manifest.version);
			expect((agentVmManifest['dependencies'] as JsonObject)['@agent-vm/gondolin-vm-adapter']).toBe(
				gondolinAdapterWorkspacePackage.manifest.version,
			);
			expect(gondolinAdapterManifest['version']).toBe(
				gondolinAdapterWorkspacePackage.manifest.version,
			);
			expect(
				(gondolinAdapterManifest['dependencies'] as JsonObject)[stockGondolinPackageName],
			).toBe(stockGondolinVersion);
			expect(gondolinManifest['name']).toBe(stockGondolinPackageName);
			expect(gondolinManifest['version']).toBe(stockGondolinVersion);

			const lockfile = await readFile(path.join(consumerDirectory, 'pnpm-lock.yaml'), 'utf8');
			expect(lockfile).not.toContain('patchedDependencies');
			expect(lockfile).not.toContain(`${stockGondolinPackageName}@patch:`);
			expect(lockfile).toMatch(
				/  '@earendil-works\/gondolin@0\.12\.0':\n    resolution: \{integrity: sha512-[^}\s]+\}/u,
			);

			const listResult = await execa(
				'pnpm',
				[
					'--dir',
					consumerDirectory,
					'list',
					stockGondolinPackageName,
					'--json',
					'--depth',
					'Infinity',
				],
				{ cwd: repositoryRoot, timeout: 60_000 },
			);
			const listedProjects: unknown = JSON.parse(listResult.stdout);
			if (!Array.isArray(listedProjects) || !isJsonObject(listedProjects[0])) {
				throw new Error('pnpm list must return one consumer project.');
			}
			const listedAgentVm = requirePnpmDependency(
				listedProjects[0]['dependencies'] as
					| Readonly<Record<string, PnpmDependencyRecord>>
					| undefined,
				'@agent-vm/agent-vm',
			);
			const listedAdapter = requirePnpmDependency(
				listedAgentVm.dependencies,
				'@agent-vm/gondolin-vm-adapter',
			);
			const listedGondolin = requirePnpmDependency(
				listedAdapter.dependencies,
				stockGondolinPackageName,
			);
			expect(listedGondolin.version).toBe(stockGondolinVersion);
			expect(listedGondolin.resolved).toBe(
				'https://registry.npmjs.org/@earendil-works/gondolin/-/gondolin-0.12.0.tgz',
			);
			expect(await realpath(listedGondolin.path ?? '')).toBe(gondolinDirectory);
			expect(gondolinDirectory).toContain(
				`${path.sep}.pnpm${path.sep}@earendil-works+gondolin@0.12.0${path.sep}`,
			);

			const consumerBytes = await storedBytes(fixtureRoot);
			expect(consumerBytes).toBeLessThan(maximumConsumerBytes);
			process.stdout.write(
				JSON.stringify({
					agentVmDirectory,
					agentVmVersion: agentVmWorkspacePackage.manifest.version,
					consumerBytes,
					gondolinAdapterDirectory,
					gondolinAdapterVersion: gondolinAdapterWorkspacePackage.manifest.version,
					gondolinDirectory,
					gondolinRegistryTarball: listedGondolin.resolved,
					packedPackageCount: workspacePackages.length,
				}) + '\n',
			);
		} finally {
			await rm(fixtureRoot, { force: true, recursive: true });
		}
	});
});
