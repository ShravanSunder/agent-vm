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
	readonly cacheDir: string;
	readonly encryption: BackupEncryption;
	readonly runtimeDir: string;
	readonly stateDir: string;
	readonly zoneFilesDir?: string;
	readonly zoneId: string;
}): Promise<BackupResult> {
	assertRuntimeDirOutsideBackupInputs({
		cacheDir: options.cacheDir,
		runtimeDir: options.runtimeDir,
		stateDir: options.stateDir,
		...(options.zoneFilesDir !== undefined ? { zoneFilesDir: options.zoneFilesDir } : {}),
	});
	const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
	const backupPaths = buildBackupPaths({
		backupDir: options.backupDir,
		timestamp,
		zoneId: options.zoneId,
	});

	await fs.mkdir(options.backupDir, { recursive: true });

	const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-stage-'));
	try {
		const stagedStateDirectory = path.join(stagingDirectory, 'state');
		await copyStateDirectoryExcludingNestedBackupDirectory({
			backupDir: options.backupDir,
			stagedStateDirectory,
			stateDir: options.stateDir,
		});
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

async function copyStateDirectoryExcludingNestedBackupDirectory(options: {
	readonly backupDir: string;
	readonly stagedStateDirectory: string;
	readonly stateDir: string;
}): Promise<void> {
	const nestedBackupRelativePath = path.relative(
		path.resolve(options.stateDir),
		path.resolve(options.backupDir),
	);
	const nestedBackupDirectory =
		nestedBackupRelativePath !== '' &&
		nestedBackupRelativePath !== '..' &&
		!nestedBackupRelativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(nestedBackupRelativePath)
			? path.resolve(options.backupDir)
			: undefined;
	if (nestedBackupDirectory === undefined) {
		await execFileAsync('cp', ['-a', options.stateDir, options.stagedStateDirectory]);
		return;
	}
	await fs.cp(options.stateDir, options.stagedStateDirectory, {
		dereference: false,
		filter: (sourcePath): boolean =>
			nestedBackupDirectory === undefined || path.resolve(sourcePath) !== nestedBackupDirectory,
		preserveTimestamps: true,
		recursive: true,
		verbatimSymlinks: true,
	});
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
