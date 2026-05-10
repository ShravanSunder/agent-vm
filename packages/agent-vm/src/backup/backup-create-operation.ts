import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	getZoneGitStatus,
	type ZoneGitReadConfig,
} from '../controller/zone-git/zone-git-operations.js';
import { buildBackupPaths } from './backup-archive-layout.js';
import type { BackupEncryption, BackupResult } from './backup-manager.js';

const execFileAsync = promisify(execFile);

export async function createEncryptedBackup(options: {
	readonly backupDir: string;
	readonly cacheDir: string;
	readonly encryption: BackupEncryption;
	readonly runtimeDir: string;
	readonly stateDir: string;
	readonly zoneFilesDir?: string;
	readonly zoneGit?: ZoneGitReadConfig;
	readonly zoneId: string;
}): Promise<BackupResult> {
	assertRuntimeDirOutsideBackupInputs({
		cacheDir: options.cacheDir,
		runtimeDir: options.runtimeDir,
		stateDir: options.stateDir,
		...(options.zoneFilesDir !== undefined ? { zoneFilesDir: options.zoneFilesDir } : {}),
	});
	if (options.zoneGit) {
		await assertZoneGitReadyForBackup(options.zoneGit);
	}
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
		if (options.zoneFilesDir !== undefined) {
			await execFileAsync('cp', [
				'-a',
				options.zoneFilesDir,
				path.join(stagingDirectory, 'zone-files'),
			]);
		}

		await fs.writeFile(
			path.join(stagingDirectory, 'manifest.json'),
			JSON.stringify({
				createdAt: new Date().toISOString(),
				timestamp,
				zoneId: options.zoneId,
			}),
		);

		const tarEntries =
			options.zoneFilesDir !== undefined
				? ['state', 'zone-files', 'manifest.json']
				: ['state', 'manifest.json'];
		await execFileAsync('tar', ['cf', backupPaths.tarPath, '-C', stagingDirectory, ...tarEntries]);
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

async function assertZoneGitReadyForBackup(zoneGit: ZoneGitReadConfig): Promise<void> {
	const status = await getZoneGitStatus(zoneGit);
	const violations: string[] = [];
	if (!status.initialized) {
		violations.push(
			`zone Git is configured but not initialized. Run agent-vm zone-git init --zone ${zoneGit.zoneId} before backup.`,
		);
	}
	if (status.dirty) {
		violations.push(
			'uncommitted zone Git changes are present. Run git status, git add, and git commit before backup.',
		);
	}
	if (status.aheadOfRemote > 0) {
		violations.push(
			`${String(status.aheadOfRemote)} unpushed zone Git commit(s) are present. Run agent-vm zone-git push --zone ${zoneGit.zoneId} before backup.`,
		);
	}
	if (violations.length > 0) {
		throw new Error(
			[
				`Zone '${zoneGit.zoneId}' is not ready for backup:`,
				...violations.map((item) => `- ${item}`),
			].join('\n'),
		);
	}
}

function isSameOrDescendantPath(childPath: string, parentPath: string): boolean {
	const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function assertNoPathOverlap(options: {
	readonly firstLabel: string;
	readonly firstPath: string;
	readonly secondLabel: string;
	readonly secondPath: string;
}): void {
	if (
		isSameOrDescendantPath(options.firstPath, options.secondPath) ||
		isSameOrDescendantPath(options.secondPath, options.firstPath)
	) {
		throw new Error(
			`${options.firstLabel} (${path.resolve(options.firstPath)}) must not overlap ${options.secondLabel} (${path.resolve(options.secondPath)}).`,
		);
	}
}

function assertRuntimeDirOutsideBackupInputs(options: {
	readonly cacheDir: string;
	readonly runtimeDir: string;
	readonly stateDir: string;
	readonly zoneFilesDir?: string;
}): void {
	assertNoPathOverlap({
		firstLabel: 'runtimeDir',
		firstPath: options.runtimeDir,
		secondLabel: 'stateDir',
		secondPath: options.stateDir,
	});
	assertNoPathOverlap({
		firstLabel: 'runtimeDir',
		firstPath: options.runtimeDir,
		secondLabel: 'cacheDir',
		secondPath: options.cacheDir,
	});
	if (options.zoneFilesDir !== undefined) {
		assertNoPathOverlap({
			firstLabel: 'runtimeDir',
			firstPath: options.runtimeDir,
			secondLabel: 'zoneFilesDir',
			secondPath: options.zoneFilesDir,
		});
	}
}
