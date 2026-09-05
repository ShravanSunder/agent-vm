import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hasBuiltImageAssets } from './build-pipeline.js';
import { verifyBuiltImageIntegrity } from './image-artifact-validation.js';

const temporaryDirectories: string[] = [];
const assetNames = {
	kernel: 'vmlinuz-virt',
	initramfs: 'initramfs.cpio.lz4',
	rootfs: 'rootfs.ext4',
};

async function createImageFixture(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'image-artifact-validation-'));
	temporaryDirectories.push(directory);
	const content = 'image asset';
	const checksum = createHash('sha256').update(content).digest('hex');
	await Promise.all(
		Object.values(assetNames).map(
			async (fileName) => await writeFile(path.join(directory, fileName), content),
		),
	);
	await writeFile(
		path.join(directory, 'manifest.json'),
		JSON.stringify({
			version: 1,
			config: { arch: 'aarch64', distro: 'alpine' },
			buildTime: '2026-09-05T00:00:00Z',
			assets: assetNames,
			checksums: { kernel: checksum, initramfs: checksum, rootfs: checksum },
		}),
	);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { recursive: true, force: true })),
	);
});

describe('image artifact structural validation', () => {
	it.each(['empty', 'directory', 'malformed-manifest', 'escaped-manifest'])(
		'rejects %s assets before reuse',
		async (invalidKind) => {
			const directory = await createImageFixture();
			if (invalidKind === 'empty') await writeFile(path.join(directory, 'rootfs.ext4'), '');
			if (invalidKind === 'directory') {
				await rm(path.join(directory, 'rootfs.ext4'));
				await mkdir(path.join(directory, 'rootfs.ext4'));
			}
			if (invalidKind === 'malformed-manifest')
				await writeFile(path.join(directory, 'manifest.json'), '{');
			if (invalidKind === 'escaped-manifest') {
				const manifest = await readFile(path.join(directory, 'manifest.json'), 'utf8');
				await writeFile(
					path.join(directory, 'manifest.json'),
					manifest.replace('rootfs.ext4', '../rootfs.ext4'),
				);
			}

			await expect(hasBuiltImageAssets(directory)).resolves.toBe(false);
		},
	);
	it('accepts supported nonempty artifact files', async () => {
		const directory = await createImageFixture();

		await expect(hasBuiltImageAssets(directory)).resolves.toBe(true);
		await expect(verifyBuiltImageIntegrity(directory)).resolves.toBe(true);
	});
	it('checks full binary hashes at publication but uses structural validation for reuse', async () => {
		const directory = await createImageFixture();
		await writeFile(path.join(directory, 'rootfs.ext4'), 'changed data');

		await expect(verifyBuiltImageIntegrity(directory)).resolves.toBe(false);
		await expect(hasBuiltImageAssets(directory)).resolves.toBe(true);
	});
});
