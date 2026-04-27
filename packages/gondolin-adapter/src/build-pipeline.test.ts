import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import type { BuildConfig } from '@earendil-works/gondolin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildImage, computeBuildFingerprint } from './build-pipeline.js';

const temporaryDirectories: string[] = [];

async function writeFakeAssets(outputDirectory: string): Promise<void> {
	await fsPromises.mkdir(outputDirectory, { recursive: true });
	await fsPromises.writeFile(path.join(outputDirectory, 'manifest.json'), '{}', 'utf8');
	await fsPromises.writeFile(path.join(outputDirectory, 'rootfs.ext4'), '', 'utf8');
	await fsPromises.writeFile(path.join(outputDirectory, 'initramfs.cpio.lz4'), '', 'utf8');
	await fsPromises.writeFile(path.join(outputDirectory, 'vmlinuz-virt'), '', 'utf8');
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const temporaryDirectory of temporaryDirectories.splice(0)) {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

describe('buildImage', () => {
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
