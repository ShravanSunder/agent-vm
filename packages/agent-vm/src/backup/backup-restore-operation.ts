import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackupEncryption, BackupRestoreResult } from './backup-manager.js';

const execFileAsync = promisify(execFile);

async function copyExtractedDirectoryContents(
	sourceDirectory: string,
	targetDirectory: string,
): Promise<void> {
	try {
		await fs.access(sourceDirectory);
	} catch {
		return;
	}

	const entries = await fs.readdir(sourceDirectory);
	await Promise.all(
		entries.map(async (entryName) => {
			await execFileAsync('cp', [
				'-a',
				path.join(sourceDirectory, entryName),
				path.join(targetDirectory, entryName),
			]);
		}),
	);
}

async function readZoneIdFromManifest(extractDirectory: string): Promise<string> {
	const manifestPath = path.join(extractDirectory, 'manifest.json');
	try {
		const rawManifest = await fs.readFile(manifestPath, 'utf8');
		const manifest = JSON.parse(rawManifest) as { readonly zoneId?: string };
		return manifest.zoneId ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

export async function restoreEncryptedBackup(options: {
	readonly backupPath: string;
	readonly encryption: BackupEncryption;
	readonly stateDir: string;
	readonly workspaceDir: string;
}): Promise<BackupRestoreResult> {
	const decryptedTarPath = `${options.backupPath}.decrypted.tar`;
	await options.encryption.decrypt(options.backupPath, decryptedTarPath);

	const extractDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-extract-'));
	try {
		await execFileAsync('tar', ['xf', decryptedTarPath, '-C', extractDirectory]);
		await copyExtractedDirectoryContents(path.join(extractDirectory, 'state'), options.stateDir);
		await copyExtractedDirectoryContents(
			path.join(extractDirectory, 'workspace'),
			options.workspaceDir,
		);

		return {
			stateDir: options.stateDir,
			workspaceDir: options.workspaceDir,
			zoneId: await readZoneIdFromManifest(extractDirectory),
		};
	} finally {
		await fs.rm(extractDirectory, { recursive: true, force: true });
		await fs.unlink(decryptedTarPath);
	}
}
