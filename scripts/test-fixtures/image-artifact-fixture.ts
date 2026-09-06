import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixtureAssetNames = {
	kernel: 'vmlinuz-virt',
	initramfs: 'initramfs.cpio.lz4',
	rootfs: 'rootfs.ext4',
};

export function imageArtifactFixtureFileContent(fileName: string): string {
	if (fileName !== 'manifest.json') return `${fileName}\n`;
	return JSON.stringify({
		version: 1,
		config: { arch: 'aarch64', distro: 'alpine' },
		buildTime: '2026-09-05T00:00:00Z',
		assets: fixtureAssetNames,
		checksums: Object.fromEntries(
			Object.entries(fixtureAssetNames).map(([role, assetName]) => [
				role,
				createHash('sha256').update(`${assetName}\n`).digest('hex'),
			]),
		),
	});
}

export function renderImageArtifactManifest(content: string): string {
	const checksum = createHash('sha256').update(content).digest('hex');
	return JSON.stringify({
		version: 1,
		config: { arch: 'aarch64', distro: 'alpine' },
		buildTime: '2026-09-05T00:00:00Z',
		assets: fixtureAssetNames,
		checksums: { kernel: checksum, initramfs: checksum, rootfs: checksum },
	});
}

export async function writeImageArtifactFixture(
	directoryPath: string,
	content: string = 'image asset\n',
): Promise<void> {
	await mkdir(directoryPath, { recursive: true });
	await Promise.all([
		...Object.values(fixtureAssetNames).map(
			async (fileName) => await writeFile(path.join(directoryPath, fileName), content),
		),
		writeFile(path.join(directoryPath, 'manifest.json'), renderImageArtifactManifest(content)),
	]);
}
