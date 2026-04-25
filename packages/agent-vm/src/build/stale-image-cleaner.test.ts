import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	deleteStaleImageDirectories,
	findStaleImageDirectories,
} from './stale-image-cleaner.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories.splice(0).map(
			async (directoryPath) => await fs.rm(directoryPath, { force: true, recursive: true }),
		),
	);
});

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-stale-images-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

describe('findStaleImageDirectories', () => {
	it('returns only stale fingerprint directories for each image type', async () => {
			const cacheDirectory = await createTemporaryDirectory();
			const currentGatewayDirectory = path.join(
				cacheDirectory,
				'gateway-images',
				'worker',
				'current-gateway',
			);
			const staleGatewayDirectory = path.join(
				cacheDirectory,
				'gateway-images',
				'worker',
				'stale-gateway',
			);
			const currentToolDirectory = path.join(
				cacheDirectory,
				'tool-vm-images',
				'default',
				'current-tool',
			);
			const staleToolDirectory = path.join(
				cacheDirectory,
				'tool-vm-images',
				'default',
				'stale-tool',
			);
			await fs.mkdir(currentGatewayDirectory, { recursive: true });
			await fs.mkdir(staleGatewayDirectory, { recursive: true });
			await fs.mkdir(currentToolDirectory, { recursive: true });
			await fs.mkdir(staleToolDirectory, { recursive: true });
			await fs.writeFile(path.join(staleGatewayDirectory, 'manifest.json'), 'gateway');
			await fs.writeFile(path.join(staleToolDirectory, 'manifest.json'), 'tool');

		const staleEntries = await findStaleImageDirectories({
				cacheDir: cacheDirectory,
				currentFingerprints: {
					gateways: { worker: 'current-gateway' },
					toolVms: { default: 'current-tool' },
				},
			});

			expect(
				staleEntries.map((entry) => `${entry.family}/${entry.profileName}/${entry.fingerprint}`),
			).toEqual([
				'gateway/worker/stale-gateway',
				'toolVm/default/stale-tool',
			]);
		expect(staleEntries.every((entry) => entry.sizeBytes > 0)).toBe(true);
	});

	it('returns stale directories for profiles no longer declared in the current config', async () => {
		const cacheDirectory = await createTemporaryDirectory();
		const removedProfileDirectory = path.join(
			cacheDirectory,
			'gateway-images',
			'old-worker',
			'old-fingerprint',
		);
		await fs.mkdir(removedProfileDirectory, { recursive: true });
		await fs.writeFile(path.join(removedProfileDirectory, 'manifest.json'), 'old');

		const staleEntries = await findStaleImageDirectories({
			cacheDir: cacheDirectory,
			currentFingerprints: {
				gateways: { worker: 'current-gateway' },
				toolVms: { default: 'current-tool' },
			},
		});

		expect(staleEntries).toContainEqual(
			expect.objectContaining({
				family: 'gateway',
				fingerprint: 'old-fingerprint',
				profileName: 'old-worker',
			}),
		);
	});

	it('returns an empty list when the cache tree does not exist', async () => {
		await expect(
			findStaleImageDirectories({
					cacheDir: path.join(await createTemporaryDirectory(), 'missing-cache'),
					currentFingerprints: {
						gateways: { worker: 'gateway' },
						toolVms: { default: 'tool' },
					},
				}),
		).resolves.toEqual([]);
	});
});

describe('deleteStaleImageDirectories', () => {
	it('removes every provided stale image directory', async () => {
			const cacheDirectory = await createTemporaryDirectory();
			const staleDirectory = path.join(cacheDirectory, 'gateway-images', 'worker', 'stale-gateway');
			await fs.mkdir(staleDirectory, { recursive: true });
			await fs.writeFile(path.join(staleDirectory, 'manifest.json'), 'gateway');

		await deleteStaleImageDirectories([
				{
					absolutePath: staleDirectory,
					family: 'gateway',
					fingerprint: 'stale-gateway',
					profileName: 'worker',
					sizeBytes: 7,
				},
			]);

			await expect(pathExists(staleDirectory)).resolves.toBe(false);
		});
});
