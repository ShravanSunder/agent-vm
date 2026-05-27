import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildImageAssetFileNames } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import {
	readPreparedGondolinImage,
	writePreparedGondolinImage,
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

		await writePreparedGondolinImage({
			buildConfigPath,
			cacheDir,
			fingerprint: 'fingerprint-1',
			fingerprintInput,
			imagePath,
		});

		await expect(readPreparedGondolinImage({ buildConfigPath, cacheDir })).resolves.toEqual({
			built: false,
			fingerprint: 'fingerprint-1',
			fingerprintInput,
			imagePath,
		});
	});

	it('ignores a prepared image record when the expected assets are missing', async () => {
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');

		await writePreparedGondolinImage({
			buildConfigPath,
			cacheDir,
			fingerprint: 'fingerprint-1',
			fingerprintInput: undefined,
			imagePath: path.join(cacheDir, 'fingerprint-1'),
		});

		await expect(readPreparedGondolinImage({ buildConfigPath, cacheDir })).resolves.toBeUndefined();
	});
});
