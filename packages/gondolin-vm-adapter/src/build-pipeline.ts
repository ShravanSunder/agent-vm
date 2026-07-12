import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildConfig, BuildOptions } from '@earendil-works/gondolin';
import { validateBuildConfig } from '@earendil-works/gondolin';

import {
	prepareBuildConfigWithAgentVmRootfsInitExtra,
	resolveRootfsInitExtra,
} from './rootfs-init-extra.js';

export type { BuildConfig } from '@earendil-works/gondolin';

export interface BuildImageOptions {
	readonly buildConfig: BuildConfig;
	readonly cacheDir: string;
	/** Directory to resolve relative paths in buildConfig (e.g. postBuild.copy.src).
	 *  Defaults to process.cwd() if not provided. */
	readonly configDir?: string;
	readonly fullReset?: boolean;
	readonly fingerprintInput?: unknown;
	readonly output?: BuildOutput;
}

export interface BuildOutput {
	write(chunk: string | Uint8Array): boolean;
}

export interface BuildImageResult {
	readonly built: boolean;
	readonly fingerprint: string;
	readonly imagePath: string;
}

export interface GondolinImageBuildToolingOptions {
	readonly buildConfig: unknown;
	readonly cacheDir: string;
	readonly configDir?: string;
	readonly fullReset?: boolean;
	readonly fingerprintInput?: unknown;
	readonly output?: BuildOutput;
}

export interface GondolinImageFingerprintOptions {
	readonly buildConfig: unknown;
	readonly configDir?: string;
	readonly fingerprintInput?: unknown;
	readonly gondolinVersion?: string;
}

export interface GondolinImageBuildTooling {
	buildImage(
		options: GondolinImageBuildToolingOptions,
		dependencies?: { readonly gondolinVersion?: string },
	): Promise<BuildImageResult>;
	computeFingerprint(options: GondolinImageFingerprintOptions): Promise<string>;
}

export const buildImageAssetFileNames = [
	'manifest.json',
	'rootfs.ext4',
	'initramfs.cpio.lz4',
	'vmlinuz-virt',
] as const;

function requireValidBuildConfig(buildConfig: unknown): BuildConfig {
	if (!validateBuildConfig(buildConfig)) {
		throw new Error('Managed VM image recipe has an invalid build shape.');
	}
	return buildConfig;
}

export function createGondolinImageBuildTooling(): GondolinImageBuildTooling {
	return {
		async buildImage(options, dependencies) {
			return await buildImage(
				{
					...options,
					buildConfig: requireValidBuildConfig(options.buildConfig),
				},
				dependencies,
			);
		},
		async computeFingerprint(options) {
			const result = await computeEffectiveBuildFingerprint({
				...options,
				buildConfig: requireValidBuildConfig(options.buildConfig),
			});
			return result.fingerprint;
		},
	};
}

interface BuildPipelineDependencies {
	readonly buildAssets?: (
		buildConfig: BuildConfig,
		outputDirectory: string,
		configDir?: string,
		workDir?: string,
		verbose?: boolean,
	) => Promise<unknown>;
	readonly gondolinVersion?: string;
}

const inFlightImageBuilds = new Map<string, Promise<BuildImageResult>>();
const gondolinWorkDirectoryName = '.agent-vm-gondolin-work';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
	}

	if (isRecord(value)) {
		const objectEntries = Object.entries(value)
			.filter(([, entryValue]) => entryValue !== undefined)
			.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
		return `{${objectEntries
			.map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${stableSerialize(entryValue)}`)
			.join(',')}}`;
	}

	return JSON.stringify(value);
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (!isMissingPathError(error)) {
			throw error;
		}
		return false;
	}
}

export async function hasBuiltImageAssets(outputDirectoryPath: string): Promise<boolean> {
	for (const fileName of buildImageAssetFileNames) {
		// oxlint-disable-next-line no-await-in-loop -- each missing file points at the same image generation
		if (!(await pathExists(path.join(outputDirectoryPath, fileName)))) {
			return false;
		}
	}
	return true;
}

async function loadBuildAssets(): Promise<
	(
		buildConfig: BuildConfig,
		outputDirectory: string,
		configDir?: string,
		workDir?: string,
		verbose?: boolean,
	) => Promise<unknown>
> {
	const gondolinModule = await import('@earendil-works/gondolin');
	return async (
		buildConfig: BuildConfig,
		outputDirectory: string,
		configDir?: string,
		workDir?: string,
		verbose?: boolean,
	): Promise<unknown> =>
		await gondolinModule.buildAssets(buildConfig, {
			outputDir: outputDirectory,
			verbose: verbose ?? false,
			...(configDir ? { configDir } : {}),
			...(workDir ? { workDir } : {}),
		} satisfies BuildOptions);
}

function createRedirectedWrite(output: BuildOutput): typeof process.stderr.write {
	return ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const writeCallback = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
		const wrote = output.write(chunk);
		writeCallback?.();
		return wrote;
	}) as typeof process.stderr.write;
}

async function withCapturedBuildOutput<TResult>(
	output: BuildOutput | undefined,
	fn: () => Promise<TResult>,
): Promise<TResult> {
	if (!output) {
		return await fn();
	}

	const originalStderrWrite = process.stderr.write.bind(process.stderr);
	const originalStdoutWrite = process.stdout.write.bind(process.stdout);
	const originalCi = process.env.CI;
	const redirectedWrite = createRedirectedWrite(output);

	process.stderr.write = redirectedWrite;
	process.stdout.write = redirectedWrite;
	process.env.CI = 'true';

	try {
		return await fn();
	} finally {
		process.stderr.write = originalStderrWrite;
		process.stdout.write = originalStdoutWrite;
		if (originalCi === undefined) {
			delete process.env.CI;
		} else {
			process.env.CI = originalCi;
		}
	}
}

export function computeBuildFingerprint(
	buildConfig: BuildConfig,
	gondolinVersion: string = 'unknown',
	fingerprintInput?: unknown,
): string {
	const payload =
		fingerprintInput === undefined
			? `${stableSerialize(buildConfig)}|${gondolinVersion}`
			: `${stableSerialize(buildConfig)}|${gondolinVersion}|${stableSerialize(fingerprintInput)}`;

	return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export async function computeEffectiveBuildFingerprint(options: {
	readonly buildConfig: BuildConfig;
	readonly configDir?: string;
	readonly fingerprintInput?: unknown;
	readonly gondolinVersion?: string;
}): Promise<{
	readonly fingerprint: string;
	readonly rootfsInitExtraContent: string;
}> {
	const resolvedRootfsInitExtra = await resolveRootfsInitExtra({
		buildConfig: options.buildConfig,
		...(options.configDir ? { configDir: options.configDir } : {}),
	});
	const fingerprint = computeBuildFingerprint(options.buildConfig, options.gondolinVersion, {
		agentVmRootfsInitExtra: resolvedRootfsInitExtra.fingerprintInput,
		...(options.fingerprintInput === undefined
			? {}
			: { callerFingerprintInput: options.fingerprintInput }),
	});

	return {
		fingerprint,
		rootfsInitExtraContent: resolvedRootfsInitExtra.content,
	};
}

export async function buildImage(
	options: BuildImageOptions,
	dependencies: BuildPipelineDependencies = {},
): Promise<BuildImageResult> {
	const effectiveBuildFingerprint = await computeEffectiveBuildFingerprint({
		buildConfig: options.buildConfig,
		...(options.configDir ? { configDir: options.configDir } : {}),
		...(options.fingerprintInput === undefined
			? {}
			: { fingerprintInput: options.fingerprintInput }),
		...(dependencies.gondolinVersion ? { gondolinVersion: dependencies.gondolinVersion } : {}),
	});
	const fingerprint = effectiveBuildFingerprint.fingerprint;
	const imagePath = path.join(options.cacheDir, fingerprint);
	const buildImageForFingerprint = async (): Promise<BuildImageResult> => {
		if (options.fullReset) {
			await fs.rm(imagePath, { recursive: true, force: true });
		}

		if (await hasBuiltImageAssets(imagePath)) {
			return {
				built: false,
				fingerprint,
				imagePath,
			};
		}

		await fs.mkdir(imagePath, { recursive: true });
		const buildAssetsImplementation = dependencies.buildAssets ?? (await loadBuildAssets());
		const effectiveBuildConfig = await prepareBuildConfigWithAgentVmRootfsInitExtra({
			buildConfig: options.buildConfig,
			imagePath,
			rootfsInitExtraContent: effectiveBuildFingerprint.rootfsInitExtraContent,
		});
		const gondolinWorkDir = path.join(imagePath, gondolinWorkDirectoryName);
		await fs.rm(gondolinWorkDir, { recursive: true, force: true });
		try {
			await withCapturedBuildOutput(options.output, async () => {
				await buildAssetsImplementation(
					effectiveBuildConfig,
					imagePath,
					options.configDir,
					gondolinWorkDir,
					options.output !== undefined,
				);
			});
		} finally {
			await fs.rm(gondolinWorkDir, { recursive: true, force: true });
		}

		if (!(await hasBuiltImageAssets(imagePath))) {
			throw new Error(`Expected Gondolin assets to be written to ${imagePath}.`);
		}

		return {
			built: true,
			fingerprint,
			imagePath,
		};
	};

	if (options.output) {
		return await buildImageForFingerprint();
	}

	const inFlightKey = path.resolve(imagePath);
	const existingBuild = inFlightImageBuilds.get(inFlightKey);
	if (existingBuild) {
		return await existingBuild;
	}
	const buildPromise = buildImageForFingerprint();
	inFlightImageBuilds.set(inFlightKey, buildPromise);
	try {
		return await buildPromise;
	} finally {
		if (inFlightImageBuilds.get(inFlightKey) === buildPromise) {
			inFlightImageBuilds.delete(inFlightKey);
		}
	}
}
