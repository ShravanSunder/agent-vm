import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackupEncryption, BackupRestoreResult } from './backup-manager.js';

const execFileAsync = promisify(execFile);

async function copyExtractedDirectoryContents(
	sourceDirectory: string,
	targetDirectory: string,
): Promise<void> {
	if (!fs.existsSync(sourceDirectory)) {
		return;
	}

	await Promise.all(
		fs.readdirSync(sourceDirectory).map(async (entryName) => {
			await execFileAsync('cp', [
				'-a',
				path.join(sourceDirectory, entryName),
				path.join(targetDirectory, entryName),
			]);
		}),
	);
}

function readZoneIdFromManifest(extractDirectory: string): string {
	const manifestPath = path.join(extractDirectory, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		return 'unknown';
	}

	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
		readonly zoneId?: string;
	};
	return manifest.zoneId ?? 'unknown';
}

export async function restoreEncryptedBackup(options: {
	readonly backupPath: string;
	readonly encryption: BackupEncryption;
	readonly stateDir: string;
	readonly workspaceDir: string;
}): Promise<BackupRestoreResult> {
	const decryptedTarPath = `${options.backupPath}.decrypted.tar`;
	await options.encryption.decrypt(options.backupPath, decryptedTarPath);

	const extractDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-extract-'));
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
			zoneId: readZoneIdFromManifest(extractDirectory),
		};
	} finally {
		fs.rmSync(extractDirectory, { recursive: true, force: true });
		fs.unlinkSync(decryptedTarPath);
	}
}
