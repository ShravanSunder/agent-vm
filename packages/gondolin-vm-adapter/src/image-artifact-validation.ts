import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateBuildConfig } from '@earendil-works/gondolin';

export const buildImageAssetFileNames = [
	'manifest.json',
	'rootfs.ext4',
	'initramfs.cpio.lz4',
	'vmlinuz-virt',
] as const;

interface ImageArtifactEntry {
	readonly fileName: string;
	readonly checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseImageArtifactEntries(value: unknown): readonly ImageArtifactEntry[] | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!validateBuildConfig(value.config) ||
		typeof value.buildTime !== 'string' ||
		!Number.isFinite(Date.parse(value.buildTime)) ||
		!isRecord(value.assets) ||
		!isRecord(value.checksums)
	)
		return undefined;
	const requiredAssets = {
		kernel: 'vmlinuz-virt',
		initramfs: 'initramfs.cpio.lz4',
		rootfs: 'rootfs.ext4',
	};
	for (const [role, fileName] of Object.entries(requiredAssets)) {
		if (value.assets[role] !== fileName) return undefined;
	}
	const entries: ImageArtifactEntry[] = [];
	for (const role of ['kernel', 'initramfs', 'rootfs', 'krunKernel', 'krunInitrd']) {
		const fileName = value.assets[role];
		if (fileName === undefined && (role === 'krunKernel' || role === 'krunInitrd')) continue;
		const checksum = value.checksums[role];
		if (
			typeof fileName !== 'string' ||
			fileName.length === 0 ||
			path.basename(fileName) !== fileName ||
			fileName === '.' ||
			fileName === '..' ||
			typeof checksum !== 'string' ||
			!/^[a-f0-9]{64}$/u.test(checksum)
		)
			return undefined;
		entries.push({ fileName, checksum });
	}
	return entries;
}

async function readValidatedArtifactEntries(
	directoryPath: string,
): Promise<readonly ImageArtifactEntry[] | undefined> {
	try {
		if (!(await lstat(directoryPath)).isDirectory()) return undefined;
		const manifestPath = path.join(directoryPath, 'manifest.json');
		const manifestStat = await lstat(manifestPath);
		if (!manifestStat.isFile() || manifestStat.size === 0) return undefined;
		const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
		const entries = parseImageArtifactEntries(manifest);
		if (entries === undefined) return undefined;
		const fileStats = await Promise.all(
			entries.map(async (entry) => await lstat(path.join(directoryPath, entry.fileName))),
		);
		return fileStats.every((fileStat) => fileStat.isFile() && fileStat.size > 0)
			? entries
			: undefined;
	} catch (error) {
		if (
			error instanceof SyntaxError ||
			(isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
		)
			return undefined;
		throw error;
	}
}

export async function hasBuiltImageAssets(directoryPath: string): Promise<boolean> {
	return (await readValidatedArtifactEntries(directoryPath)) !== undefined;
}

async function hashImageArtifact(filePath: string): Promise<string> {
	const fileHandle = await open(filePath, 'r');
	try {
		const hash = createHash('sha256');
		for await (const chunk of fileHandle.createReadStream({ autoClose: false })) {
			if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary image artifact data.');
			hash.update(chunk);
		}
		return hash.digest('hex');
	} finally {
		await fileHandle.close();
	}
}

export async function verifyBuiltImageIntegrity(directoryPath: string): Promise<boolean> {
	const entries = await readValidatedArtifactEntries(directoryPath);
	if (entries === undefined) return false;
	const verifiedEntries = await Promise.all(
		entries.map(
			async (entry) =>
				(await hashImageArtifact(path.join(directoryPath, entry.fileName))) === entry.checksum,
		),
	);
	return verifiedEntries.every(Boolean);
}
