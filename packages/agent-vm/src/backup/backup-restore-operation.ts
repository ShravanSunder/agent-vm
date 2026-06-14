import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackupEncryption, BackupRestoreResult } from './backup-manager.js';

export type BackupOperationExecFileAsync = (
	command: string,
	args: readonly string[],
) => Promise<void>;

interface StagedRestoreDirectory {
	readonly incomingDirectory: string;
	incomingPromoted: boolean;
	readonly preRestoreDirectory: string;
	readonly targetDirectory: string;
	targetMoved: boolean;
}

const realExecFileAsync = promisify(execFile);

const defaultExecFileAsync: BackupOperationExecFileAsync = async (
	command: string,
	args: readonly string[],
): Promise<void> => {
	await realExecFileAsync(command, [...args]);
};

function writeRestoreLog(message: string): void {
	process.stderr.write(`[agent-vm backup] ${message}\n`);
}

async function copyExtractedDirectoryContents(
	sourceDirectory: string,
	targetDirectory: string,
	execFileAsync: BackupOperationExecFileAsync,
): Promise<void> {
	await fs.mkdir(targetDirectory, { recursive: true });
	const entries = await fs.readdir(sourceDirectory);
	await Promise.all(
		entries.map(
			async (entryName) =>
				await execFileAsync('cp', [
					'-a',
					path.join(sourceDirectory, entryName),
					path.join(targetDirectory, entryName),
				]),
		),
	);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function stageDirectoryContents(options: {
	readonly execFileAsync: BackupOperationExecFileAsync;
	readonly restoreId: string;
	readonly sourceDirectory: string;
	readonly targetDirectory: string;
}): Promise<StagedRestoreDirectory | null> {
	if (!(await pathExists(options.sourceDirectory))) {
		return null;
	}

	const parentDirectory = path.dirname(options.targetDirectory);
	const incomingDirectory = path.join(
		parentDirectory,
		`${path.basename(options.targetDirectory)}.incoming-${options.restoreId}`,
	);
	const preRestoreDirectory = path.join(
		parentDirectory,
		`${path.basename(options.targetDirectory)}.pre-restore-${options.restoreId}`,
	);

	try {
		await copyExtractedDirectoryContents(
			options.sourceDirectory,
			incomingDirectory,
			options.execFileAsync,
		);
	} catch (error) {
		await fs.rm(incomingDirectory, { recursive: true, force: true });
		throw error;
	}

	return {
		incomingDirectory,
		incomingPromoted: false,
		preRestoreDirectory,
		targetDirectory: options.targetDirectory,
		targetMoved: false,
	};
}

async function stageRequiredDirectoryContents(options: {
	readonly archiveDirectoryName: string;
	readonly execFileAsync: BackupOperationExecFileAsync;
	readonly restoreId: string;
	readonly sourceDirectory: string;
	readonly targetDirectory: string;
}): Promise<StagedRestoreDirectory> {
	const stagedDirectory = await stageDirectoryContents(options);
	if (stagedDirectory === null) {
		throw new Error(
			`Backup archive is missing required '${options.archiveDirectoryName}' directory.`,
		);
	}
	return stagedDirectory;
}

async function promoteStagedDirectory(stagedDirectory: StagedRestoreDirectory): Promise<void> {
	const parentDirectory = path.dirname(stagedDirectory.targetDirectory);
	try {
		await fs.mkdir(parentDirectory, { recursive: true });
		if (await pathExists(stagedDirectory.targetDirectory)) {
			await fs.rename(stagedDirectory.targetDirectory, stagedDirectory.preRestoreDirectory);
			stagedDirectory.targetMoved = true;
		}
		await fs.rename(stagedDirectory.incomingDirectory, stagedDirectory.targetDirectory);
		stagedDirectory.incomingPromoted = true;
	} catch (error) {
		if (stagedDirectory.targetMoved && !(await pathExists(stagedDirectory.targetDirectory))) {
			await fs.rename(stagedDirectory.preRestoreDirectory, stagedDirectory.targetDirectory);
			stagedDirectory.targetMoved = false;
		}
		throw error;
	}
}

async function rollbackPromotedDirectory(stagedDirectory: StagedRestoreDirectory): Promise<void> {
	if (stagedDirectory.incomingPromoted) {
		await fs.rm(stagedDirectory.targetDirectory, { recursive: true, force: true });
		stagedDirectory.incomingPromoted = false;
	}
	if (stagedDirectory.targetMoved && (await pathExists(stagedDirectory.preRestoreDirectory))) {
		await fs.rename(stagedDirectory.preRestoreDirectory, stagedDirectory.targetDirectory);
		stagedDirectory.targetMoved = false;
	}
}

async function restoreStagedDirectories(
	stagedDirectories: readonly StagedRestoreDirectory[],
): Promise<void> {
	const promotedDirectories: StagedRestoreDirectory[] = [];
	try {
		for (const stagedDirectory of stagedDirectories) {
			// oxlint-disable-next-line no-await-in-loop -- restore promotion is ordered so rollback can reverse it
			await promoteStagedDirectory(stagedDirectory);
			promotedDirectories.push(stagedDirectory);
		}
		for (const promotedDirectory of promotedDirectories) {
			if (promotedDirectory.targetMoved) {
				writeRestoreLog(
					`Retained pre-restore directory '${promotedDirectory.preRestoreDirectory}' for manual recovery.`,
				);
			}
		}
	} catch (error) {
		for (const stagedDirectory of promotedDirectories.toReversed()) {
			// oxlint-disable-next-line no-await-in-loop -- rollback must reverse successful promotions one at a time
			await rollbackPromotedDirectory(stagedDirectory);
		}
		throw error;
	} finally {
		await Promise.all(
			stagedDirectories.map(async (stagedDirectory) => {
				if (!stagedDirectory.incomingPromoted) {
					await fs.rm(stagedDirectory.incomingDirectory, { recursive: true, force: true });
				}
			}),
		);
	}
}

async function cleanupUnpromotedIncomingDirectories(
	stagedDirectories: readonly StagedRestoreDirectory[],
): Promise<void> {
	await Promise.all(
		stagedDirectories.map(async (stagedDirectory) => {
			if (!stagedDirectory.incomingPromoted) {
				await fs.rm(stagedDirectory.incomingDirectory, { recursive: true, force: true });
			}
		}),
	);
}

async function readZoneIdFromManifest(extractDirectory: string): Promise<string> {
	const manifestPath = path.join(extractDirectory, 'manifest.json');
	const rawManifest = await fs.readFile(manifestPath, 'utf8');
	const manifest: unknown = JSON.parse(rawManifest);
	if (
		typeof manifest !== 'object' ||
		manifest === null ||
		!('zoneId' in manifest) ||
		typeof manifest.zoneId !== 'string' ||
		manifest.zoneId.length === 0
	) {
		throw new Error(`Backup manifest at ${manifestPath} must contain a non-empty zoneId.`);
	}
	return manifest.zoneId;
}

export async function restoreEncryptedBackup(options: {
	readonly backupPath: string;
	readonly encryption: BackupEncryption;
	readonly stateDir: string;
	readonly zoneFilesDir?: string;
	readonly execFileAsync?: BackupOperationExecFileAsync;
}): Promise<BackupRestoreResult> {
	const execFileAsync = options.execFileAsync ?? defaultExecFileAsync;
	const transientDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-'));
	const decryptedTarPath = path.join(transientDirectory, path.basename(options.backupPath, '.age'));
	const extractDirectory = path.join(transientDirectory, 'extract');

	try {
		await fs.mkdir(extractDirectory, { recursive: true });
		await options.encryption.decrypt(options.backupPath, decryptedTarPath);
		await execFileAsync('tar', ['xf', decryptedTarPath, '-C', extractDirectory]);
		const zoneId = await readZoneIdFromManifest(extractDirectory);
		const restoreId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
		const stagedDirectories: StagedRestoreDirectory[] = [];
		try {
			const stagedStateDirectory = await stageRequiredDirectoryContents({
				archiveDirectoryName: 'state',
				execFileAsync,
				restoreId,
				sourceDirectory: path.join(extractDirectory, 'state'),
				targetDirectory: options.stateDir,
			});
			stagedDirectories.push(stagedStateDirectory);
			if (options.zoneFilesDir !== undefined) {
				const stagedZoneFilesDirectory = await stageRequiredDirectoryContents({
					archiveDirectoryName: 'zone-files',
					execFileAsync,
					restoreId,
					sourceDirectory: path.join(extractDirectory, 'zone-files'),
					targetDirectory: options.zoneFilesDir,
				});
				stagedDirectories.push(stagedZoneFilesDirectory);
			}
			await restoreStagedDirectories(stagedDirectories);
		} catch (error) {
			await cleanupUnpromotedIncomingDirectories(stagedDirectories);
			throw error;
		}

		return {
			stateDir: options.stateDir,
			...(options.zoneFilesDir !== undefined ? { zoneFilesDir: options.zoneFilesDir } : {}),
			zoneId,
		};
	} finally {
		await fs.rm(transientDirectory, { recursive: true, force: true });
	}
}
