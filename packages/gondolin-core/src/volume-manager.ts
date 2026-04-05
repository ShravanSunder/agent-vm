import fs from 'node:fs';
import path from 'node:path';

export interface VolumeConfigEntry {
	readonly guestPath: string;
}

export interface ResolvedVolume {
	readonly hostDir: string;
	readonly guestPath: string;
}

export function ensureVolumeDir(
	cacheBase: string,
	workspaceHash: string,
	volumeName: string,
): string {
	const volumeDirectory = path.join(cacheBase, workspaceHash, volumeName);
	fs.mkdirSync(volumeDirectory, { recursive: true });
	return volumeDirectory;
}

export function resolveVolumeDirs(
	cacheBase: string,
	workspaceHash: string,
	volumes: Readonly<Record<string, VolumeConfigEntry>>,
): Record<string, ResolvedVolume> {
	const resolvedVolumes: Record<string, ResolvedVolume> = {};

	for (const [volumeName, volumeConfig] of Object.entries(volumes)) {
		resolvedVolumes[volumeName] = {
			guestPath: volumeConfig.guestPath,
			hostDir: ensureVolumeDir(cacheBase, workspaceHash, volumeName),
		};
	}

	return resolvedVolumes;
}
