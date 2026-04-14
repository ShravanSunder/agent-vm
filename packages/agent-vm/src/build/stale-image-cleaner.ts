import fs from 'node:fs';
import path from 'node:path';

export interface StaleImageEntry {
	readonly absolutePath: string;
	readonly imageType: 'gateway' | 'tool';
	readonly name: string;
	readonly sizeBytes: number;
}

function getDirectorySizeBytes(directoryPath: string): number {
	let totalSizeBytes = 0;
	try {
		for (const directoryEntry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
			const absoluteEntryPath = path.join(directoryPath, directoryEntry.name);
			if (directoryEntry.isDirectory()) {
				totalSizeBytes += getDirectorySizeBytes(absoluteEntryPath);
				continue;
			}
			if (directoryEntry.isFile()) {
				totalSizeBytes += fs.statSync(absoluteEntryPath).size;
			}
		}
	} catch {
		return totalSizeBytes;
	}
	return totalSizeBytes;
}

export function findStaleImageDirectories(options: {
	readonly cacheDir: string;
	readonly currentFingerprints: { readonly gateway: string; readonly tool: string };
}): readonly StaleImageEntry[] {
	const staleEntries: StaleImageEntry[] = [];

	for (const imageType of ['gateway', 'tool'] as const) {
		const imageCacheDirectory = path.join(options.cacheDir, 'images', imageType);
		if (!fs.existsSync(imageCacheDirectory)) {
			continue;
		}

		const currentFingerprint = options.currentFingerprints[imageType];
		for (const directoryEntry of fs.readdirSync(imageCacheDirectory, { withFileTypes: true })) {
			if (!directoryEntry.isDirectory() || directoryEntry.name === currentFingerprint) {
				continue;
			}

			const absolutePath = path.join(imageCacheDirectory, directoryEntry.name);
			staleEntries.push({
				absolutePath,
				imageType,
				name: directoryEntry.name,
				sizeBytes: getDirectorySizeBytes(absolutePath),
			});
		}
	}

	return staleEntries;
}

export function deleteStaleImageDirectories(entries: readonly StaleImageEntry[]): void {
	for (const entry of entries) {
		fs.rmSync(entry.absolutePath, { force: true, recursive: true });
	}
}
