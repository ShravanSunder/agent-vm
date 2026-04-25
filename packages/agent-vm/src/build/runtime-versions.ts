import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimePackageVersions {
	readonly agentVm: string;
	readonly gondolinAdapter: string;
	readonly gondolinPackage: string;
}

interface PackageJson {
	readonly name?: string;
	readonly version?: string;
	readonly dependencies?: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readOptionalString(
	record: Readonly<Record<string, unknown>>,
	propertyName: string,
): string | undefined {
	const value = record[propertyName];
	return typeof value === 'string' ? value : undefined;
}

function readStringDependencyMap(
	record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> | undefined {
	const dependencies = record.dependencies;
	if (!isRecord(dependencies)) {
		return undefined;
	}

	return Object.fromEntries(
		Object.entries(dependencies).filter((dependency): dependency is [string, string] => {
			const [, dependencyVersion] = dependency;
			return typeof dependencyVersion === 'string';
		}),
	);
}

function parsePackageJson(rawContents: string, packageJsonPath: string): PackageJson {
	const parsed = JSON.parse(rawContents) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`Invalid package.json at ${packageJsonPath}: expected object.`);
	}

	const name = readOptionalString(parsed, 'name');
	const version = readOptionalString(parsed, 'version');
	const dependencies = readStringDependencyMap(parsed);
	return {
		...(name ? { name } : {}),
		...(version ? { version } : {}),
		...(dependencies ? { dependencies } : {}),
	};
}

export async function findPackageJsonPathFromStart(startPath: string): Promise<string> {
	let searchDirectory = path.dirname(path.resolve(startPath));

	for (;;) {
		const candidatePath = path.join(searchDirectory, 'package.json');
		try {
			await fs.access(candidatePath);
			return candidatePath;
		} catch (error) {
			if (
				!(
					typeof error === 'object' &&
					error !== null &&
					'code' in error &&
					error.code === 'ENOENT'
				)
			) {
				throw error;
			}
			const parentDirectory = path.dirname(searchDirectory);
			if (parentDirectory === searchDirectory) {
				throw new Error(`Could not find package.json above ${startPath}.`);
			}
			searchDirectory = parentDirectory;
		}
	}
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
	return parsePackageJson(await fs.readFile(packageJsonPath, 'utf8'), packageJsonPath);
}

function requirePackageVersion(packageJson: PackageJson, packageJsonPath: string): string {
	if (!packageJson.version) {
		throw new Error(`Missing version in ${packageJsonPath}.`);
	}
	return packageJson.version;
}

function formatGondolinDependencyVersion(dependencyVersion: string): string {
	const npmAliasMatch = /^npm:.+@([^@]+)$/u.exec(dependencyVersion);
	return `@earendil-works/gondolin@${npmAliasMatch?.[1] ?? dependencyVersion}`;
}

export async function readRuntimePackageVersions(options: {
	readonly agentVmPackageJsonPath: string;
	readonly gondolinAdapterPackageJsonPath: string;
}): Promise<RuntimePackageVersions> {
	const agentVmPackageJson = await readPackageJson(options.agentVmPackageJsonPath);
	const gondolinAdapterPackageJson = await readPackageJson(options.gondolinAdapterPackageJsonPath);
	const gondolinPackage = gondolinAdapterPackageJson.dependencies?.['@earendil-works/gondolin'];
	if (!gondolinPackage) {
		throw new Error(
			`Missing @earendil-works/gondolin dependency in ${options.gondolinAdapterPackageJsonPath}.`,
		);
	}

	return {
		agentVm: requirePackageVersion(agentVmPackageJson, options.agentVmPackageJsonPath),
		gondolinAdapter: requirePackageVersion(
			gondolinAdapterPackageJson,
			options.gondolinAdapterPackageJsonPath,
		),
		gondolinPackage: formatGondolinDependencyVersion(gondolinPackage),
	};
}

export function formatRuntimeBuildVersionTag(versions: RuntimePackageVersions): string {
	return [
		`agent-vm@${versions.agentVm}`,
		`gondolin-adapter@${versions.gondolinAdapter}`,
		`gondolin@${versions.gondolinPackage}`,
	].join('+');
}

export async function resolveRuntimeBuildVersionTag(): Promise<string> {
	const agentVmPackageJsonPath = await findPackageJsonPathFromStart(fileURLToPath(import.meta.url));
	const gondolinAdapterModulePath = fileURLToPath(
		import.meta.resolve('@agent-vm/gondolin-adapter'),
	);
	const gondolinAdapterPackageJsonPath = await findPackageJsonPathFromStart(
		gondolinAdapterModulePath,
	);

	return formatRuntimeBuildVersionTag(
		await readRuntimePackageVersions({
			agentVmPackageJsonPath,
			gondolinAdapterPackageJsonPath,
		}),
	);
}
