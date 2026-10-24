/// <reference types="node" />
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isReleasePackageName, listReleasePackages } from './release-package-selection.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stableSemanticVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(sourceText: string): JsonRecord {
	const parsedValue: unknown = JSON.parse(sourceText);
	if (!isJsonRecord(parsedValue)) {
		throw new Error('Expected a JSON object.');
	}
	return parsedValue;
}

export function parseReleaseVersion(candidateVersion: string): string {
	if (!stableSemanticVersionPattern.test(candidateVersion)) {
		throw new Error(
			`Release version must be a stable semantic version, received: ${candidateVersion}`,
		);
	}
	return candidateVersion;
}

export function renderNpmPackageVersion(sourceText: string, releaseVersion: string): string {
	const manifest = parseJsonRecord(sourceText);
	if (!isReleasePackageName(manifest.name)) {
		throw new Error('Release package manifest must declare a release-scope package name.');
	}
	manifest.version = releaseVersion;
	return `${JSON.stringify(manifest, null, '\t')}\n`;
}

export function renderPythonProjectVersion(sourceText: string, releaseVersion: string): string {
	const versionDeclarations = sourceText.match(/^version = "[^"]+"$/gmu) ?? [];
	if (versionDeclarations.length !== 1) {
		throw new Error(
			`Expected exactly one Python project version, found ${versionDeclarations.length}.`,
		);
	}
	return sourceText.replace(/^version = "[^"]+"$/mu, `version = "${releaseVersion}"`);
}

export function renderHermesAdapterProjectVersion(
	sourceText: string,
	releaseVersion: string,
): string {
	const versionedProject = renderPythonProjectVersion(sourceText, releaseVersion);
	const sdkPins = versionedProject.match(/agent-vm-agent-portal-sdk==[^"\s]+/gu) ?? [];
	if (sdkPins.length !== 1) {
		throw new Error(`Expected exactly one Hermes adapter SDK pin, found ${sdkPins.length}.`);
	}
	return versionedProject.replace(
		/agent-vm-agent-portal-sdk==[^"\s]+/u,
		`agent-vm-agent-portal-sdk==${releaseVersion}`,
	);
}

async function runRepositoryCommand(command: string, args: readonly string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repositoryRoot,
			stdio: 'inherit',
		});
		child.once('error', reject);
		child.once('exit', (exitCode, signal) => {
			if (exitCode === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`${command} ${args.join(' ')} failed with ${signal === null ? `exit code ${String(exitCode)}` : `signal ${signal}`}.`,
				),
			);
		});
	});
}

export async function updateReleaseFiles(
	targetRepositoryRoot: string,
	releaseVersion: string,
): Promise<void> {
	const releasePackages = await listReleasePackages(targetRepositoryRoot);
	const packageManifestSources = await Promise.all(
		releasePackages.map(async ({ manifestPath }) => {
			const absoluteManifestPath = path.join(targetRepositoryRoot, manifestPath);
			return {
				manifestPath: absoluteManifestPath,
				sourceText: await readFile(absoluteManifestPath, 'utf8'),
			};
		}),
	);
	await Promise.all(
		packageManifestSources.map(async ({ manifestPath, sourceText }) => {
			await writeFile(manifestPath, renderNpmPackageVersion(sourceText, releaseVersion));
		}),
	);

	const sdkProjectPath = path.join(
		targetRepositoryRoot,
		'python',
		'agent-vm-agent-portal-sdk',
		'pyproject.toml',
	);
	const adapterProjectPath = path.join(
		targetRepositoryRoot,
		'python',
		'agent-vm-hermes-adapter',
		'pyproject.toml',
	);
	await writeFile(
		sdkProjectPath,
		renderPythonProjectVersion(await readFile(sdkProjectPath, 'utf8'), releaseVersion),
	);
	await writeFile(
		adapterProjectPath,
		renderHermesAdapterProjectVersion(await readFile(adapterProjectPath, 'utf8'), releaseVersion),
	);

	process.stdout.write(
		`[release-version] updated ${String(packageManifestSources.length)} npm and 2 Python manifests\n`,
	);
}

async function main(): Promise<void> {
	const positionalArguments = process.argv.slice(2).filter((argument) => argument !== '--');
	if (positionalArguments.length !== 1) {
		throw new Error('Usage: pnpm release:version -- <stable-version>');
	}
	const releaseVersion = parseReleaseVersion(positionalArguments[0] ?? '');
	await updateReleaseFiles(repositoryRoot, releaseVersion);
	await runRepositoryCommand('pnpm', ['install', '--lockfile-only']);
	await runRepositoryCommand('uv', ['lock']);
	await runRepositoryCommand('bash', ['scripts/check-package-version-sync.sh']);
	process.stdout.write(`[release-version] synchronized release ${releaseVersion}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
