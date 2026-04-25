import fs from 'node:fs/promises';
import path from 'node:path';

export interface VolumeConfigEntry {
	readonly guestPath: string;
}

export interface ResolvedVolume {
	readonly hostDir: string;
	readonly guestPath: string;
}

export async function ensureVolumeDir(
	cacheBase: string,
	workspaceHash: string,
	volumeName: string,
): Promise<string> {
	const volumeDirectory = path.join(cacheBase, workspaceHash, volumeName);
	await fs.mkdir(volumeDirectory, { recursive: true });
	return volumeDirectory;
}

export async function resolveVolumeDirs(
	cacheBase: string,
	workspaceHash: string,
	volumes: Readonly<Record<string, VolumeConfigEntry>>,
): Promise<Record<string, ResolvedVolume>> {
	const resolvedVolumeEntries = await Promise.all(
		Object.entries(volumes).map(
			async ([volumeName, volumeConfig]) =>
				[
					volumeName,
					{
						guestPath: volumeConfig.guestPath,
						hostDir: await ensureVolumeDir(cacheBase, workspaceHash, volumeName),
					},
				] satisfies readonly [string, ResolvedVolume],
		),
	);

	return Object.fromEntries(resolvedVolumeEntries);
}
