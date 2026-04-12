import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildBackupPaths } from './backup-archive-layout.js';
import type { BackupEncryption, BackupResult } from './backup-manager.js';

const execFileAsync = promisify(execFile);

export async function createEncryptedBackup(options: {
	readonly backupDir: string;
	readonly encryption: BackupEncryption;
	readonly stateDir: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}): Promise<BackupResult> {
	const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
	const backupPaths = buildBackupPaths({
		backupDir: options.backupDir,
		timestamp,
		zoneId: options.zoneId,
	});

	await fs.mkdir(options.backupDir, { recursive: true });

	const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-stage-'));
	try {
		await execFileAsync('cp', ['-a', options.stateDir, path.join(stagingDirectory, 'state')]);
		await execFileAsync('cp', [
			'-a',
			options.workspaceDir,
			path.join(stagingDirectory, 'workspace'),
		]);

		await fs.writeFile(
			path.join(stagingDirectory, 'manifest.json'),
			JSON.stringify({
				createdAt: new Date().toISOString(),
				timestamp,
				zoneId: options.zoneId,
			}),
		);

		await execFileAsync('tar', [
			'cf',
			backupPaths.tarPath,
			'-C',
			stagingDirectory,
			'state',
			'workspace',
			'manifest.json',
		]);
	} finally {
		await fs.rm(stagingDirectory, { recursive: true, force: true });
	}

	await options.encryption.encrypt(backupPaths.tarPath, backupPaths.encryptedPath);
	await fs.unlink(backupPaths.tarPath);

	return {
		backupPath: backupPaths.encryptedPath,
		timestamp,
		zoneId: options.zoneId,
	};
}
