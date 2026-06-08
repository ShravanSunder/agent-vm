import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildImageAssetFileNames } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePreparedGondolinImage } from '../build/prepared-gondolin-image-cache.js';
import { buildGatewayImage } from './gateway-image-builder.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-image-'));
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
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { recursive: true, force: true })),
	);
});

describe('buildGatewayImage', () => {
	it('uses a prepared gateway image record without rebuilding Gondolin assets', async () => {
		const cacheDir = await createTemporaryDirectory();
		const buildConfigPath = path.join(cacheDir, '..', 'build-config.jsonc');
		const imagePath = path.join(cacheDir, 'prepared-fingerprint');
		await writeFakeImageAssets(imagePath);
		await writePreparedGondolinImage({
			buildConfigPath,
			cacheDir,
			fingerprint: 'prepared-fingerprint',
			fingerprintInput: { dockerRootfsIdentity: { layers: ['sha256:gateway'] }, schemaVersion: 1 },
			imagePath,
		});
		const buildGondolinImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'rebuilt-fingerprint',
			imagePath: path.join(cacheDir, 'rebuilt-fingerprint'),
		}));

		const result = await buildGatewayImage(
			{
				buildConfigPath,
				cacheDir,
			},
			{ buildGondolinImage },
		);

		expect(result).toEqual({
			built: false,
			fingerprint: 'prepared-fingerprint',
			imagePath,
		});
		expect(buildGondolinImage).not.toHaveBeenCalled();
	});
});
