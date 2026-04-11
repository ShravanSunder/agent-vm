import fs from 'node:fs';
import path from 'node:path';

import type { SnapshotEncryption } from '../snapshots/snapshot-manager.js';

export function resolveCheckpointPath(
	checkpointsBaseDirectory: string,
	zoneId: string,
	imageFingerprint: string,
): string {
	return path.join(checkpointsBaseDirectory, zoneId, `gateway-${imageFingerprint}.qcow2`);
}

export function shouldUseCheckpoint(checkpointPath: string): boolean {
	return fs.existsSync(checkpointPath);
}

export async function encryptCheckpointFile(
	checkpointPath: string,
	encryption: SnapshotEncryption,
): Promise<string> {
	const encryptedPath = `${checkpointPath}.age`;
	await encryption.encrypt(checkpointPath, encryptedPath);
	return encryptedPath;
}

export async function decryptCheckpointFile(
	encryptedPath: string,
	encryption: SnapshotEncryption,
): Promise<string> {
	const decryptedPath = encryptedPath.replace(/\.age$/u, '');
	await encryption.decrypt(encryptedPath, decryptedPath);
	return decryptedPath;
}
