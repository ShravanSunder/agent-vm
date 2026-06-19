import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { stripJsonComments } from './jsonc-comments.ts';

const execFileAsync = promisify(execFile);

const packagesToInspect = ['openclaw', '@openclaw/discord', '@openclaw/codex'] as const;
const expectedPatchedUndiciVersion = '8.5.0';

export interface InspectOpenClawRuntimeImageOptions {
	readonly buildConfigPath?: string;
	readonly image?: string;
}

export interface OpenClawRuntimePackageInspection {
	readonly name: string;
	readonly undici: readonly OpenClawRuntimeUndiciInspection[];
	readonly version: string;
}

export interface OpenClawRuntimeUndiciInspection {
	readonly path: string;
	readonly resolvedFrom: string;
	readonly version: string;
}

export interface OpenClawRuntimeImageInspection {
	readonly image: string;
	readonly packages: readonly OpenClawRuntimePackageInspection[];
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseInspectOpenClawRuntimeImageArgs(
	args: readonly string[],
): InspectOpenClawRuntimeImageOptions {
	let buildConfigPath: string | undefined;
	let image: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--build-config') {
			buildConfigPath = args[index + 1];
			index += 1;
			continue;
		}
		if (arg === '--image') {
			image = args[index + 1];
			index += 1;
			continue;
		}
		throw new Error(
			`Unknown argument '${arg}'. Usage: tsx scripts/inspect-openclaw-runtime-image.ts --image <tag>`,
		);
	}
	if ((buildConfigPath === undefined) === (image === undefined)) {
		throw new Error('Pass exactly one of --image <tag> or --build-config <path>.');
	}
	return {
		...(buildConfigPath === undefined ? {} : { buildConfigPath }),
		...(image === undefined ? {} : { image }),
	};
}

async function readImageFromBuildConfig(buildConfigPath: string): Promise<string> {
	const parsedConfig: unknown = JSON.parse(
		stripJsonComments(await readFile(buildConfigPath, 'utf8')),
	);
	if (
		!isJsonRecord(parsedConfig) ||
		!isJsonRecord(parsedConfig.oci) ||
		typeof parsedConfig.oci.image !== 'string' ||
		parsedConfig.oci.image.length === 0
	) {
		throw new Error(`${buildConfigPath} must contain oci.image.`);
	}
	return parsedConfig.oci.image;
}

async function resolveImage(options: InspectOpenClawRuntimeImageOptions): Promise<string> {
	if (options.image !== undefined) {
		return options.image;
	}
	if (options.buildConfigPath !== undefined) {
		return await readImageFromBuildConfig(options.buildConfigPath);
	}
	throw new Error('Expected image or buildConfigPath.');
}

const inImageInspectionScript = `
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const packageNames = ${JSON.stringify(packagesToInspect)};
const runtimeNodeModules = execFileSync('pnpm', ['root', '-g'], { encoding: 'utf8' }).trim();

function readPackageJson(packageJsonPath) {
	return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function isDirectory(entryPath) {
	try {
		return fs.statSync(entryPath).isDirectory();
	} catch {
		return false;
	}
}

function listUndiciPackageJsonPaths(packageRoot) {
	const visitedDirectories = new Set();
	const matches = [];
	function walk(directoryPath) {
		let realDirectoryPath;
		try {
			realDirectoryPath = fs.realpathSync(directoryPath);
		} catch {
			return;
		}
		if (visitedDirectories.has(realDirectoryPath)) {
			return;
		}
		visitedDirectories.add(realDirectoryPath);
		let entries;
		try {
			entries = fs.readdirSync(directoryPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isFile() && entry.name === 'package.json') {
				const normalizedPath = entryPath.split(path.sep).join('/');
				if (normalizedPath.endsWith('/node_modules/undici/package.json')) {
					matches.push(entryPath);
				}
				continue;
			}
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				if (isDirectory(entryPath)) {
					walk(entryPath);
				}
			}
		}
	}
	walk(packageRoot);
	return matches.toSorted();
}

function inspectPackage(packageName) {
	const packageRoot = path.join(runtimeNodeModules, packageName);
	const packageJsonPath = path.join(packageRoot, 'package.json');
	const packageJson = readPackageJson(packageJsonPath);
	const undici = listUndiciPackageJsonPaths(packageRoot).map((undiciPackageJsonPath) => {
		const undiciPackageJson = readPackageJson(undiciPackageJsonPath);
		return {
			path: path.relative(packageRoot, undiciPackageJsonPath),
			resolvedFrom: packageName,
			version: undiciPackageJson.version,
		};
	});
	return {
		name: packageName,
		version: packageJson.version,
		undici,
	};
}

console.log(JSON.stringify({
	image: process.env.AGENT_VM_INSPECT_IMAGE_TAG,
	packages: packageNames.map(inspectPackage),
}));
`;

export function parseOpenClawRuntimeImageInspection(
	stdout: string,
): OpenClawRuntimeImageInspection {
	const parsedOutput: unknown = JSON.parse(stdout.trim());
	if (!isJsonRecord(parsedOutput) || typeof parsedOutput.image !== 'string') {
		throw new Error(`Unexpected inspection output: ${stdout}`);
	}
	if (!Array.isArray(parsedOutput.packages)) {
		throw new Error(`Inspection output missing packages: ${stdout}`);
	}
	const packages: OpenClawRuntimePackageInspection[] = [];
	for (const packageInspection of parsedOutput.packages) {
		if (
			!isJsonRecord(packageInspection) ||
			typeof packageInspection.name !== 'string' ||
			typeof packageInspection.version !== 'string'
		) {
			throw new Error(`Invalid package inspection entry: ${JSON.stringify(packageInspection)}`);
		}
		if (!Array.isArray(packageInspection.undici)) {
			throw new Error(`Invalid undici inspection entry: ${JSON.stringify(packageInspection)}`);
		}
		const undici = packageInspection.undici.map((undiciInspection: unknown) => {
			if (
				!isJsonRecord(undiciInspection) ||
				typeof undiciInspection.path !== 'string' ||
				typeof undiciInspection.resolvedFrom !== 'string' ||
				typeof undiciInspection.version !== 'string'
			) {
				throw new Error(`Invalid undici inspection entry: ${JSON.stringify(packageInspection)}`);
			}
			return {
				path: undiciInspection.path,
				resolvedFrom: undiciInspection.resolvedFrom,
				version: undiciInspection.version,
			};
		});
		packages.push({
			name: packageInspection.name,
			undici,
			version: packageInspection.version,
		});
	}
	const inspection = {
		image: parsedOutput.image,
		packages,
	};
	assertExpectedUndiciVersions(inspection);
	return inspection;
}

function assertExpectedUndiciVersions(inspection: OpenClawRuntimeImageInspection): void {
	for (const packageInspection of inspection.packages) {
		for (const undiciInspection of packageInspection.undici) {
			if (undiciInspection.version !== expectedPatchedUndiciVersion) {
				throw new Error(
					`Unexpected ${packageInspection.name} undici@${undiciInspection.version} at ${undiciInspection.path}; expected ${expectedPatchedUndiciVersion}.`,
				);
			}
		}
	}
}

export async function inspectOpenClawRuntimeImage(
	options: InspectOpenClawRuntimeImageOptions,
): Promise<OpenClawRuntimeImageInspection> {
	const image = await resolveImage(options);
	const { stdout } = await execFileAsync(
		'docker',
		[
			'run',
			'--rm',
			'--entrypoint',
			'node',
			'--env',
			`AGENT_VM_INSPECT_IMAGE_TAG=${image}`,
			image,
			'--input-type=module',
			'--eval',
			inImageInspectionScript,
		],
		{ maxBuffer: 5 * 1024 * 1024 },
	);
	return parseOpenClawRuntimeImageInspection(stdout);
}

export function formatOpenClawRuntimeImageInspection(
	inspection: OpenClawRuntimeImageInspection,
): string {
	const lines = [`OpenClaw runtime image inspection: image=${inspection.image}`];
	for (const packageInspection of inspection.packages) {
		const undiciText =
			packageInspection.undici.length === 0
				? 'undici=not-resolved'
				: packageInspection.undici
						.map(
							(undiciInspection) =>
								`undici@${undiciInspection.version} resolvedFrom=${undiciInspection.resolvedFrom} path=${undiciInspection.path}`,
						)
						.join(', ');
		lines.push(`  ${packageInspection.name}@${packageInspection.version} -> ${undiciText}`);
	}
	lines.push('');
	return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	inspectOpenClawRuntimeImage(parseInspectOpenClawRuntimeImageArgs(process.argv.slice(2)))
		.then((inspection) => {
			process.stdout.write(formatOpenClawRuntimeImageInspection(inspection));
		})
		.catch((error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
}
