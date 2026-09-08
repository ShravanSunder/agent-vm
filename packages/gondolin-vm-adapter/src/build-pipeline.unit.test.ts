import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type { BuildConfig } from '@earendil-works/gondolin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeImageArtifactFixture } from '../../../scripts/test-fixtures/image-artifact-fixture.js';
import {
	buildImage,
	computeBuildFingerprint,
	computeEffectiveBuildFingerprint,
	createGondolinImageBuildTooling,
} from './build-pipeline.js';
import * as imageArtifactValidation from './image-artifact-validation.js';

vi.mock('./image-directory-publication.js', () => ({
	assertImagePublicationSupport: async (): Promise<void> => {},
	publishImageDirectory: async (sourcePath: string, destinationPath: string): Promise<void> => {
		try {
			await fsPromises.lstat(destinationPath);
		} catch (error) {
			if (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				await fsPromises.rename(sourcePath, destinationPath);
				return;
			}
			throw error;
		}
		throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
	},
}));

const temporaryDirectories: string[] = [];

async function writeFakeAssets(outputDirectory: string): Promise<void> {
	await writeImageArtifactFixture(outputDirectory);
}

function createFileSystemError(code: string, message: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const temporaryDirectory of temporaryDirectories.splice(0)) {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

describe('buildImage', () => {
	it('projects fingerprinting through the narrow build-tooling capability', async () => {
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
		};
		const tooling = createGondolinImageBuildTooling();

		const [projectedFingerprint, directFingerprint] = await Promise.all([
			tooling.computeFingerprint({ buildConfig, gondolinVersion: 'gondolin@1' }),
			computeEffectiveBuildFingerprint({ buildConfig, gondolinVersion: 'gondolin@1' }),
		]);

		expect(projectedFingerprint).toBe(directFingerprint.fingerprint);
	});

	it('rejects invalid recipes at the narrow build-tooling boundary', async () => {
		const tooling = createGondolinImageBuildTooling();

		await expect(tooling.computeFingerprint({ buildConfig: { distro: 'alpine' } })).rejects.toThrow(
			'invalid build shape',
		);
	});

	it('injects rootfs init lines that recreate standard /dev fd symlinks at boot', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gondolin-root',
			},
		};
		let effectiveRootfsInitExtraPath: string | undefined;

		const result = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
			},
			{
				buildAssets: async (
					effectiveBuildConfig: BuildConfig,
					outputDirectory: string,
				): Promise<void> => {
					effectiveRootfsInitExtraPath = effectiveBuildConfig.init?.rootfsInitExtra;
					await writeFakeAssets(outputDirectory);
				},
				gondolinVersion: 'gondolin@1',
			},
		);

		expect(effectiveRootfsInitExtraPath).toBeDefined();
		const publishedRootfsInitExtraPath = path.join(
			result.imagePath,
			'agent-vm-rootfs-init-extra.sh',
		);
		const rootfsInitExtraContent = await fsPromises.readFile(publishedRootfsInitExtraPath, 'utf8');
		const rootfsInitExtraStat = await fsPromises.stat(publishedRootfsInitExtraPath);

		expect(rootfsInitExtraContent).toContain('ln -sfn /proc/self/fd /dev/fd');
		expect(rootfsInitExtraContent).toContain('ln -sfn /proc/self/fd/0 /dev/stdin');
		expect(rootfsInitExtraContent).toContain('ln -sfn /proc/self/fd/1 /dev/stdout');
		expect(rootfsInitExtraContent).toContain('ln -sfn /proc/self/fd/2 /dev/stderr');
		expect(rootfsInitExtraContent).toContain('ln -sfn pts/ptmx /dev/ptmx');
		expect(rootfsInitExtraStat.mode & 0o777).toBe(0o755);
	});

	it('runs agent-vm /dev setup before deployment rootfs init extras', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-config-'));
		temporaryDirectories.push(cacheDirectory, configDirectory);
		await fsPromises.writeFile(
			path.join(configDirectory, 'deployment-init-extra.sh'),
			'if [ ! -e /dev/fd ]; then exit 91; fi\n',
			'utf8',
		);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			init: {
				rootfsInitExtra: './deployment-init-extra.sh',
			},
		};
		let effectiveRootfsInitExtraPath: string | undefined;

		const result = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
				configDir: configDirectory,
			},
			{
				buildAssets: async (
					effectiveBuildConfig: BuildConfig,
					outputDirectory: string,
				): Promise<void> => {
					effectiveRootfsInitExtraPath = effectiveBuildConfig.init?.rootfsInitExtra;
					await writeFakeAssets(outputDirectory);
				},
				gondolinVersion: 'gondolin@1',
			},
		);

		expect(effectiveRootfsInitExtraPath).toBeDefined();
		const rootfsInitExtraContent = await fsPromises.readFile(
			path.join(result.imagePath, 'agent-vm-rootfs-init-extra.sh'),
			'utf8',
		);

		expect(rootfsInitExtraContent.indexOf('ln -sfn /proc/self/fd /dev/fd')).toBeLessThan(
			rootfsInitExtraContent.indexOf('if [ ! -e /dev/fd ]; then exit 91; fi'),
		);
	});

	it('rebuilds when deployment rootfs init extra content changes', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-config-'));
		temporaryDirectories.push(cacheDirectory, configDirectory);
		const deploymentRootfsInitExtraPath = path.join(configDirectory, 'deployment-init-extra.sh');
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			init: {
				rootfsInitExtra: './deployment-init-extra.sh',
			},
		};
		const fakeBuildIntoDirectory = vi.fn(
			async (_buildConfig: BuildConfig, outputDirectory: string): Promise<void> => {
				await writeFakeAssets(outputDirectory);
			},
		);

		await fsPromises.writeFile(deploymentRootfsInitExtraPath, 'echo init-extra-v1\n', 'utf8');
		const firstResult = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
				configDir: configDirectory,
			},
			{
				buildAssets: fakeBuildIntoDirectory,
				gondolinVersion: 'gondolin@1',
			},
		);
		await fsPromises.writeFile(deploymentRootfsInitExtraPath, 'echo init-extra-v2\n', 'utf8');
		const secondResult = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
				configDir: configDirectory,
			},
			{
				buildAssets: fakeBuildIntoDirectory,
				gondolinVersion: 'gondolin@1',
			},
		);

		expect(firstResult.built).toBe(true);
		expect(secondResult.built).toBe(true);
		expect(secondResult.fingerprint).not.toBe(firstResult.fingerprint);
		expect(secondResult.imagePath).not.toBe(firstResult.imagePath);
		expect(fakeBuildIntoDirectory).toHaveBeenCalledTimes(2);
	});

	it('reuses an existing fingerprinted image directory without rebuilding', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gondolin-root',
			},
		};

		const fakeBuildIntoDirectory = vi.fn(
			async (_buildConfig: unknown, outputDirectory: string): Promise<void> => {
				await writeFakeAssets(outputDirectory);
			},
		);

		const firstResult = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
			},
			{
				buildAssets: fakeBuildIntoDirectory,
			},
		);

		const secondResult = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
			},
			{
				buildAssets: fakeBuildIntoDirectory,
			},
		);

		expect(firstResult.built).toBe(true);
		expect(secondResult.built).toBe(false);
		expect(secondResult.fingerprint).toBe(firstResult.fingerprint);
		expect(secondResult.imagePath).toBe(firstResult.imagePath);
		expect(fakeBuildIntoDirectory).toHaveBeenCalledTimes(1);
	});

	it('publishes a completed build from a staging directory', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		let observedBuildDirectory: string | undefined;

		const result = await buildImage(
			{
				buildConfig: { arch: 'aarch64', distro: 'alpine' },
				cacheDir: cacheDirectory,
			},
			{
				buildAssets: async (_buildConfig, outputDirectory): Promise<void> => {
					observedBuildDirectory = outputDirectory;
					await writeFakeAssets(outputDirectory);
				},
				gondolinVersion: 'gondolin@1',
			},
		);

		expect(observedBuildDirectory).not.toBe(result.imagePath);
		expect(path.basename(observedBuildDirectory ?? '')).toContain('.staging-');
		await expect(fsPromises.access(result.imagePath)).resolves.toBeUndefined();
		await expect(fsPromises.access(observedBuildDirectory ?? '')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('does not replace a complete immutable fingerprint during a forced rebuild', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const fakeBuildIntoDirectory = vi.fn(
			async (_buildConfig: BuildConfig, outputDirectory: string): Promise<void> => {
				await writeFakeAssets(outputDirectory);
			},
		);
		const options = {
			buildConfig: { arch: 'aarch64', distro: 'alpine' } satisfies BuildConfig,
			cacheDir: cacheDirectory,
		};

		const firstResult = await buildImage(options, {
			buildAssets: fakeBuildIntoDirectory,
			gondolinVersion: 'gondolin@1',
		});
		const forcedResult = await buildImage(
			{ ...options, fullReset: true },
			{ buildAssets: fakeBuildIntoDirectory, gondolinVersion: 'gondolin@1' },
		);

		expect(firstResult.built).toBe(true);
		expect(forcedResult).toEqual({ ...firstResult, built: false });
		expect(fakeBuildIntoDirectory).toHaveBeenCalledOnce();
	});

	it('fails closed when the final fingerprint directory is incomplete', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const buildConfig = { arch: 'aarch64', distro: 'alpine' } satisfies BuildConfig;
		const { fingerprint } = await computeEffectiveBuildFingerprint({
			buildConfig,
			gondolinVersion: 'gondolin@1',
		});
		const incompleteImagePath = path.join(cacheDirectory, fingerprint);
		await fsPromises.mkdir(incompleteImagePath, { recursive: true });
		await fsPromises.writeFile(path.join(incompleteImagePath, 'manifest.json'), '{}', 'utf8');
		const fakeBuildIntoDirectory = vi.fn();

		await expect(
			buildImage(
				{ buildConfig, cacheDir: cacheDirectory },
				{ buildAssets: fakeBuildIntoDirectory, gondolinVersion: 'gondolin@1' },
			),
		).rejects.toThrow(new RegExp(`Incomplete shared image artifact.*${fingerprint}`, 'u'));
		expect(fakeBuildIntoDirectory).not.toHaveBeenCalled();
	});

	it('removes owned failed staging even when another publisher completes', async () => {
		const cacheDirectory = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), 'gondolin-failed-staging-'),
		);
		temporaryDirectories.push(cacheDirectory);
		const buildConfig = { arch: 'aarch64', distro: 'alpine' } satisfies BuildConfig;
		const { fingerprint } = await computeEffectiveBuildFingerprint({
			buildConfig,
			gondolinVersion: 'gondolin@1',
		});
		const winnerPath = path.join(cacheDirectory, fingerprint);

		await expect(
			buildImage(
				{ buildConfig, cacheDir: cacheDirectory },
				{
					gondolinVersion: 'gondolin@1',
					buildAssets: async (_buildConfig, outputDirectory): Promise<void> => {
						await writeFakeAssets(outputDirectory);
						await writeFakeAssets(winnerPath);
						throw new Error('local build failed');
					},
				},
			),
		).rejects.toThrow('local build failed');

		await expect(fsPromises.readdir(cacheDirectory)).resolves.toEqual([fingerprint]);
	});

	it('rejects checksum-mismatched staging without publishing an artifact', async () => {
		const cacheDirectory = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), 'gondolin-corrupt-staging-'),
		);
		temporaryDirectories.push(cacheDirectory);

		await expect(
			buildImage(
				{ buildConfig: { arch: 'aarch64', distro: 'alpine' }, cacheDir: cacheDirectory },
				{
					buildAssets: async (_buildConfig, outputDirectory): Promise<void> => {
						await writeFakeAssets(outputDirectory);
						await fsPromises.writeFile(path.join(outputDirectory, 'rootfs.ext4'), 'corrupt data');
					},
				},
			),
		).rejects.toThrow(/Expected Gondolin assets/u);

		await expect(fsPromises.readdir(cacheDirectory)).resolves.toEqual([]);
	});

	it('preserves staging evidence when a concurrent final artifact is incomplete', async () => {
		const cacheDirectory = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), 'gondolin-incomplete-winner-'),
		);
		temporaryDirectories.push(cacheDirectory);
		const buildConfig = { arch: 'aarch64', distro: 'alpine' } satisfies BuildConfig;
		const { fingerprint } = await computeEffectiveBuildFingerprint({
			buildConfig,
			gondolinVersion: 'gondolin@1',
		});
		const winnerPath = path.join(cacheDirectory, fingerprint);

		await expect(
			buildImage(
				{ buildConfig, cacheDir: cacheDirectory },
				{
					gondolinVersion: 'gondolin@1',
					buildAssets: async (_buildConfig, outputDirectory): Promise<void> => {
						await writeFakeAssets(outputDirectory);
						await fsPromises.mkdir(winnerPath);
						await fsPromises.writeFile(path.join(winnerPath, 'manifest.json'), 'incomplete winner');
					},
				},
			),
		).rejects.toThrow(/Concurrent image publication/u);

		const entries = await fsPromises.readdir(cacheDirectory);
		expect(entries).toContain(fingerprint);
		expect(entries.filter((entry) => entry.includes('.staging-'))).toHaveLength(1);
		await expect(fsPromises.readFile(path.join(winnerPath, 'manifest.json'), 'utf8')).resolves.toBe(
			'incomplete winner',
		);
	});

	it('dedupes concurrent identical image builds in process', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gondolin-root',
			},
		};
		let releaseBuild: (() => void) | undefined;
		const releaseBuildPromise = new Promise<void>((resolve) => {
			releaseBuild = resolve;
		});
		const firstBuildStarted = Promise.withResolvers<void>();
		const fakeBuildIntoDirectory = vi.fn(
			async (_buildConfig: unknown, outputDirectory: string): Promise<void> => {
				firstBuildStarted.resolve();
				await releaseBuildPromise;
				await writeFakeAssets(outputDirectory);
			},
		);

		const firstResultPromise = buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
				fingerprintInput: { dockerRootfsIdentity: { layers: ['sha256:a'] } },
			},
			{
				buildAssets: fakeBuildIntoDirectory,
				gondolinVersion: 'gondolin@1',
			},
		);
		await firstBuildStarted.promise;
		const secondResultPromise = buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
				fingerprintInput: { dockerRootfsIdentity: { layers: ['sha256:a'] } },
			},
			{
				buildAssets: fakeBuildIntoDirectory,
				gondolinVersion: 'gondolin@1',
			},
		);
		releaseBuild?.();

		const [firstResult, secondResult] = await Promise.all([
			firstResultPromise,
			secondResultPromise,
		]);

		expect(firstResult).toEqual(secondResult);
		expect(fakeBuildIntoDirectory).toHaveBeenCalledOnce();
	});

	it('surfaces access failures while checking existing fingerprinted image assets', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gondolin-root',
			},
		};
		const fakeBuildIntoDirectory = vi.fn(
			async (_buildConfig: unknown, outputDirectory: string): Promise<void> => {
				await writeFakeAssets(outputDirectory);
			},
		);
		const firstResult = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
			},
			{
				buildAssets: fakeBuildIntoDirectory,
			},
		);
		const inaccessibleAssetPath = path.join(firstResult.imagePath, 'manifest.json');
		vi.spyOn(imageArtifactValidation, 'hasBuiltImageAssets').mockRejectedValueOnce(
			createFileSystemError('EACCES', `permission denied: ${inaccessibleAssetPath}`),
		);

		await expect(
			buildImage(
				{
					buildConfig,
					cacheDir: cacheDirectory,
				},
				{
					buildAssets: fakeBuildIntoDirectory,
				},
			),
		).rejects.toMatchObject({ code: 'EACCES' });
		expect(fakeBuildIntoDirectory).toHaveBeenCalledTimes(1);
	});

	it('does not use synchronous filesystem helpers inside the async build path', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gondolin-root',
			},
		};
		const existsSyncSpy = vi.spyOn(fs, 'existsSync');
		const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
		const rmSyncSpy = vi.spyOn(fs, 'rmSync');

		await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
				fullReset: true,
			},
			{
				buildAssets: async (_buildConfig: BuildConfig, outputDirectory: string): Promise<void> => {
					await writeFakeAssets(outputDirectory);
				},
			},
		);

		expect(existsSyncSpy).not.toHaveBeenCalled();
		expect(mkdirSyncSpy).not.toHaveBeenCalled();
		expect(rmSyncSpy).not.toHaveBeenCalled();
	});

	it('routes Gondolin process output to the provided stream and disables dynamic progress', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const verboseValues: (boolean | undefined)[] = [];
		const outputChunks: string[] = [];
		const output = new Writable({
			write(chunk, _encoding, callback) {
				outputChunks.push(String(chunk));
				callback();
			},
		});
		const originalCi = process.env.CI;

		await buildImage(
			{
				buildConfig: {
					arch: 'aarch64',
					distro: 'alpine',
					rootfs: {
						label: 'gondolin-root',
					},
				},
				cacheDir: cacheDirectory,
				output,
			},
			{
				buildAssets: async (
					_buildConfig: BuildConfig,
					outputDirectory: string,
					_configDir?: string,
					_workDir?: string,
					verbose?: boolean,
				): Promise<void> => {
					verboseValues.push(verbose);
					if (process.env.CI !== 'true') {
						throw new Error('Expected CI=true while Gondolin build output is captured.');
					}
					process.stderr.write('building rootfs\n');
					await writeFakeAssets(outputDirectory);
				},
				gondolinVersion: 'gondolin@1',
			},
		);

		expect(verboseValues).toEqual([true]);
		expect(outputChunks.join('')).toContain('building rootfs');
		expect(process.env.CI).toBe(originalCi);
	});
});

describe('computeBuildFingerprint', () => {
	it('produces different fingerprints when postBuild changes', () => {
		const baseConfig = {
			alpine: { version: '3.23.0' },
			arch: 'aarch64',
			distro: 'alpine',
		};
		const withPostBuild = {
			...baseConfig,
			postBuild: {
				commands: ['update-ca-certificates'],
			},
		};

		expect(computeBuildFingerprint(baseConfig as BuildConfig)).not.toBe(
			computeBuildFingerprint(withPostBuild as BuildConfig),
		);
	});

	it('produces the same fingerprint for identical postBuild configs', () => {
		const configA = {
			arch: 'aarch64',
			postBuild: { commands: ['echo hello'] },
		};
		const configB = {
			arch: 'aarch64',
			postBuild: { commands: ['echo hello'] },
		};

		expect(computeBuildFingerprint(configA as BuildConfig)).toBe(
			computeBuildFingerprint(configB as BuildConfig),
		);
	});

	it('changes the fingerprint when fingerprint input changes', () => {
		const buildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
		};

		expect(
			computeBuildFingerprint(buildConfig as BuildConfig, 'unknown', {
				gitSha: '1111111',
				schemaVersion: 1,
			}),
		).not.toBe(
			computeBuildFingerprint(buildConfig as BuildConfig, 'unknown', {
				gitSha: '2222222',
				schemaVersion: 1,
			}),
		);
	});

	it('preserves the legacy fingerprint when fingerprint input is omitted', () => {
		const buildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
		};
		const legacyPayload = computeBuildFingerprint(buildConfig as BuildConfig, 'unknown');

		expect(computeBuildFingerprint(buildConfig as BuildConfig, 'unknown', undefined)).toBe(
			legacyPayload,
		);
	});
});
