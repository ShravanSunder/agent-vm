import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BuildConfig } from '@earendil-works/gondolin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildImage, computeBuildFingerprint } from './build-pipeline.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const temporaryDirectory of temporaryDirectories.splice(0)) {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

describe('buildImage', () => {
	it('reuses an existing fingerprinted image directory without rebuilding', async () => {
		const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gondolin-core-build-cache-'));
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
});
