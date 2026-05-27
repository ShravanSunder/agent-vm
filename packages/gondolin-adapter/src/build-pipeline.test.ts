import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type { BuildConfig } from '@earendil-works/gondolin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildImage, buildImageAssetFileNames, computeBuildFingerprint } from './build-pipeline.js';

const temporaryDirectories: string[] = [];

async function writeFakeAssets(outputDirectory: string): Promise<void> {
	await fsPromises.mkdir(outputDirectory, { recursive: true });
	for (const fileName of buildImageAssetFileNames) {
		// oxlint-disable-next-line no-await-in-loop -- fake assets mirror the build cache contract
		await fsPromises.writeFile(path.join(outputDirectory, fileName), '', 'utf8');
	}
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

		await buildImage(
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
		const rootfsInitExtraContent = await fsPromises.readFile(
			effectiveRootfsInitExtraPath ?? '',
			'utf8',
		);
		const rootfsInitExtraStat = await fsPromises.stat(effectiveRootfsInitExtraPath ?? '');

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

		await buildImage(
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
			effectiveRootfsInitExtraPath ?? '',
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
				fs.mkdirSync(outputDirectory, { recursive: true });
				fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), '{}', 'utf8');
				fs.writeFileSync(path.join(outputDirectory, 'rootfs.ext4'), '', 'utf8');
				fs.writeFileSync(path.join(outputDirectory, 'initramfs.cpio.lz4'), '', 'utf8');
				fs.writeFileSync(path.join(outputDirectory, 'vmlinuz-virt'), '', 'utf8');
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

	it('moves Gondolin work rootfs into output instead of copying it', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-adapter-build-cache-'));
		temporaryDirectories.push(cacheDirectory);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gondolin-root',
			},
		};
		let rootfsSourceWasMoved = false;
		let capturedWorkDir: string | undefined;

		const result = await buildImage(
			{
				buildConfig,
				cacheDir: cacheDirectory,
			},
			{
				buildAssets: async (
					_buildConfig: BuildConfig,
					outputDirectory: string,
					_configDir?: string,
					workDir?: string,
				): Promise<void> => {
					if (!workDir) {
						throw new Error('Expected an explicit Gondolin work directory.');
					}
					capturedWorkDir = workDir;
					await fsPromises.mkdir(workDir, { recursive: true });
					await fsPromises.mkdir(outputDirectory, { recursive: true });
					const workRootfsPath = path.join(workDir, 'rootfs.ext4');
					await fsPromises.writeFile(workRootfsPath, 'rootfs-from-work', 'utf8');
					fs.copyFileSync(workRootfsPath, path.join(outputDirectory, 'rootfs.ext4'));
					rootfsSourceWasMoved = !fs.existsSync(workRootfsPath);
					await fsPromises.writeFile(path.join(outputDirectory, 'manifest.json'), '{}', 'utf8');
					await fsPromises.writeFile(path.join(outputDirectory, 'initramfs.cpio.lz4'), '', 'utf8');
					await fsPromises.writeFile(path.join(outputDirectory, 'vmlinuz-virt'), '', 'utf8');
				},
				gondolinVersion: 'gondolin@1',
			},
		);

		expect(rootfsSourceWasMoved).toBe(true);
		await expect(
			fsPromises.readFile(path.join(result.imagePath, 'rootfs.ext4'), 'utf8'),
		).resolves.toBe('rootfs-from-work');
		await expect(fsPromises.access(capturedWorkDir ?? '')).rejects.toMatchObject({
			code: 'ENOENT',
		});
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
		const originalAccess = fsPromises.access;
		vi.spyOn(fsPromises, 'access').mockImplementation(
			async (...accessArgs: Parameters<typeof fsPromises.access>): Promise<void> => {
				if (path.resolve(String(accessArgs[0])) === path.resolve(inaccessibleAssetPath)) {
					throw createFileSystemError('EACCES', `permission denied: ${inaccessibleAssetPath}`);
				}
				await originalAccess(...accessArgs);
			},
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
					await fsPromises.mkdir(outputDirectory, { recursive: true });
					await fsPromises.writeFile(path.join(outputDirectory, 'manifest.json'), '{}', 'utf8');
					await fsPromises.writeFile(path.join(outputDirectory, 'rootfs.ext4'), '', 'utf8');
					await fsPromises.writeFile(path.join(outputDirectory, 'initramfs.cpio.lz4'), '', 'utf8');
					await fsPromises.writeFile(path.join(outputDirectory, 'vmlinuz-virt'), '', 'utf8');
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
				buildAssets: async (_buildConfig: BuildConfig, outputDirectory: string): Promise<void> => {
					if (process.env.CI !== 'true') {
						throw new Error('Expected CI=true while Gondolin build output is captured.');
					}
					process.stderr.write('building rootfs\n');
					await writeFakeAssets(outputDirectory);
				},
				gondolinVersion: 'gondolin@1',
			},
		);

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
