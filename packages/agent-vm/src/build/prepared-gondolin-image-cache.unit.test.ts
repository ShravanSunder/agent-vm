import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { managedVmImageAssetFileNames as buildImageAssetFileNames } from './gondolin-managed-vm-build-tooling.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
	readPreparedManagedVmImage,
	writePreparedManagedVmImage,
} from './prepared-gondolin-image-cache.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await fs.mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-prepared-image-'),
	);
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function writeFakeImageAssets(imagePath: string): Promise<void> {
	await fs.mkdir(imagePath, { recursive: true });
	await Promise.all(
		buildImageAssetFileNames.map(
			async (fileName) => await fs.writeFile(path.join(imagePath, fileName), '', 'utf8'),
		),
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { recursive: true, force: true })),
	);
});

describe('prepared Gondolin image cache', () => {
	it('reads a prepared image when the record matches the build config and assets exist', async () => {
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');
		const imagePath = path.join(cacheDir, 'fingerprint-1');
		await writeFakeImageAssets(imagePath);
		const fingerprintInput = {
			dockerRootfsIdentity: {
				architecture: 'arm64',
				layers: ['sha256:layer-a'],
				os: 'linux',
			},
			schemaVersion: 1,
		};

		await writePreparedManagedVmImage({
			buildConfigPath,
			cacheDir,
			fingerprint: 'fingerprint-1',
			fingerprintInput,
			imagePath,
		});

		await expect(readPreparedManagedVmImage({ buildConfigPath, cacheDir })).resolves.toEqual({
			built: false,
			fingerprint: 'fingerprint-1',
			fingerprintInput,
			imagePath,
		});
	});

	it('ignores a prepared image record when the expected assets are missing', async () => {
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');

		await writePreparedManagedVmImage({
			buildConfigPath,
			cacheDir,
			fingerprint: 'fingerprint-1',
			fingerprintInput: undefined,
			imagePath: path.join(cacheDir, 'fingerprint-1'),
		});

		await expect(readPreparedManagedVmImage({ buildConfigPath, cacheDir })).resolves.toBeUndefined();
	});

	it('preserves the exact managed Gateway boot projection in the prepared receipt', async () => {
		// Arrange
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');
		const imagePath = path.join(cacheDir, 'managed-gateway-fingerprint');
		const managedGatewayBoot = {
			frameworkBootEntry: 'openclaw-framework-service',
			kind: 'managed-gateway-exact-two-role',
		} as const;
		await writeFakeImageAssets(imagePath);

		// Act
		await writePreparedManagedVmImage({
			buildConfigPath,
			cacheDir,
			fingerprint: 'managed-gateway-fingerprint',
			imagePath,
			managedGatewayBoot,
		});

		// Assert
		await expect(readPreparedManagedVmImage({ buildConfigPath, cacheDir })).resolves.toMatchObject(
			{
				managedGatewayBoot,
			},
		);
	});

	it('invalidates legacy prepared-image receipts that predate the managed boot contract', async () => {
		// Arrange
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');
		const imagePath = path.join(cacheDir, 'legacy-fingerprint');
		await writeFakeImageAssets(imagePath);
		await fs.writeFile(
			path.join(cacheDir, 'prepared-image.json'),
			`${JSON.stringify({
				buildConfigPath: path.resolve(buildConfigPath),
				fingerprint: 'legacy-fingerprint',
				imagePath: path.resolve(imagePath),
				schemaVersion: 1,
			})}\n`,
			'utf8',
		);

		// Act and assert
		await expect(readPreparedManagedVmImage({ buildConfigPath, cacheDir })).resolves.toBeUndefined();
	});

	it('ignores a corrupted prepared image record', async () => {
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');
		await fs.writeFile(path.join(cacheDir, 'prepared-image.json'), '{not-json', 'utf8');

		await expect(readPreparedManagedVmImage({ buildConfigPath, cacheDir })).resolves.toBeUndefined();
	});

	it('uses unique temporary record paths for concurrent writers', async () => {
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');
		const firstImagePath = path.join(cacheDir, 'fingerprint-1');
		const secondImagePath = path.join(cacheDir, 'fingerprint-2');
		await writeFakeImageAssets(firstImagePath);
		await writeFakeImageAssets(secondImagePath);

		await Promise.all([
			writePreparedManagedVmImage({
				buildConfigPath,
				cacheDir,
				fingerprint: 'fingerprint-1',
				imagePath: firstImagePath,
			}),
			writePreparedManagedVmImage({
				buildConfigPath,
				cacheDir,
				fingerprint: 'fingerprint-2',
				imagePath: secondImagePath,
			}),
		]);

		const preparedImage = await readPreparedManagedVmImage({ buildConfigPath, cacheDir });
		expect(preparedImage?.fingerprint).toMatch(/^fingerprint-[12]$/u);
	});
});
