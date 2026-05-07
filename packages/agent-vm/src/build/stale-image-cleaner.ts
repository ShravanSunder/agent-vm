import fs from 'node:fs/promises';
import path from 'node:path';

export interface StaleImageEntry {
	readonly absolutePath: string;
	readonly family: 'gateway' | 'toolVm';
	readonly fingerprint: string;
	readonly modifiedAtMs: number;
	readonly profileName: string;
	readonly sizeBytes: number;
}

export interface CurrentImageFingerprints {
	readonly gateways: Record<string, string>;
	readonly toolVms: Record<string, string>;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function getDirectorySizeBytes(directoryPath: string): Promise<number> {
	let totalSizeBytes = 0;
	try {
		for (const directoryEntry of await fs.readdir(directoryPath, { withFileTypes: true })) {
			const absoluteEntryPath = path.join(directoryPath, directoryEntry.name);
			if (directoryEntry.isDirectory()) {
				totalSizeBytes += await getDirectorySizeBytes(absoluteEntryPath);
				continue;
			}
			if (directoryEntry.isFile()) {
				totalSizeBytes += (await fs.stat(absoluteEntryPath)).size;
			}
		}
	} catch {
		return totalSizeBytes;
	}
	return totalSizeBytes;
}

export async function findStaleImageDirectories(options: {
	readonly cacheDir: string;
	readonly currentFingerprints: CurrentImageFingerprints;
}): Promise<readonly StaleImageEntry[]> {
	const staleEntries: StaleImageEntry[] = [];

	for (const [family, cacheDirectoryName, currentFingerprints] of [
		['gateway', 'gateway-images', options.currentFingerprints.gateways],
		['toolVm', 'tool-vm-images', options.currentFingerprints.toolVms],
	] as const) {
		const familyCacheDirectory = path.join(options.cacheDir, cacheDirectoryName);
		if (!(await pathExists(familyCacheDirectory))) {
			continue;
		}

		for (const profileDirectoryEntry of await fs.readdir(familyCacheDirectory, {
			withFileTypes: true,
		})) {
			if (!profileDirectoryEntry.isDirectory()) {
				continue;
			}
			const profileName = profileDirectoryEntry.name;
			const currentFingerprint = currentFingerprints[profileName] ?? null;
			const imageCacheDirectory = path.join(familyCacheDirectory, profileName);
			for (const directoryEntry of await fs.readdir(imageCacheDirectory, { withFileTypes: true })) {
				if (!directoryEntry.isDirectory() || directoryEntry.name === currentFingerprint) {
					continue;
				}

				const absolutePath = path.join(imageCacheDirectory, directoryEntry.name);
				const directoryStat = await fs.stat(absolutePath);
				staleEntries.push({
					absolutePath,
					family,
					fingerprint: directoryEntry.name,
					modifiedAtMs: directoryStat.mtimeMs,
					profileName,
					sizeBytes: await getDirectorySizeBytes(absolutePath),
				});
			}
		}
	}

	return staleEntries;
}

function groupImageEntriesByProfile(
	entries: readonly StaleImageEntry[],
): Map<string, readonly StaleImageEntry[]> {
	const groupedEntries = new Map<string, StaleImageEntry[]>();
	for (const entry of entries) {
		const groupKey = `${entry.family}/${entry.profileName}`;
		const group = groupedEntries.get(groupKey) ?? [];
		group.push(entry);
		groupedEntries.set(groupKey, group);
	}

	return new Map(
		[...groupedEntries.entries()].map(([groupKey, group]) => [
			groupKey,
			group.toSorted((leftEntry, rightEntry) => {
				const modifiedDifference = rightEntry.modifiedAtMs - leftEntry.modifiedAtMs;
				if (modifiedDifference !== 0) {
					return modifiedDifference;
				}
				return leftEntry.fingerprint.localeCompare(rightEntry.fingerprint);
			}),
		]),
	);
}

export async function findPrunableImageDirectories(options: {
	readonly cacheDir: string;
	readonly currentFingerprints: CurrentImageFingerprints;
	readonly retainStaleGenerationsPerProfile: number;
}): Promise<readonly StaleImageEntry[]> {
	const staleEntries = await findStaleImageDirectories({
		cacheDir: options.cacheDir,
		currentFingerprints: options.currentFingerprints,
	});
	const prunableEntries: StaleImageEntry[] = [];

	for (const group of groupImageEntriesByProfile(staleEntries).values()) {
		prunableEntries.push(...group.slice(options.retainStaleGenerationsPerProfile));
	}

	return prunableEntries;
}

export async function deleteStaleImageDirectories(
	entries: readonly StaleImageEntry[],
): Promise<void> {
	await Promise.all(
		entries.map(async (entry) => await fs.rm(entry.absolutePath, { force: true, recursive: true })),
	);
}
