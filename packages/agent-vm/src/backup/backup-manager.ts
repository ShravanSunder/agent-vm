import { listBackupArtifacts } from './backup-archive-layout.js';
import { createEncryptedBackup } from './backup-create-operation.js';
import { restoreEncryptedBackup } from './backup-restore-operation.js';

export interface BackupEncryption {
	readonly encrypt: (inputPath: string, outputPath: string) => Promise<void>;
	readonly decrypt: (inputPath: string, outputPath: string) => Promise<void>;
}

export interface BackupResult {
	readonly backupPath: string;
	readonly timestamp: string;
	readonly zoneId: string;
}

export interface BackupRestoreResult {
	readonly stateDir: string;
	readonly zoneFilesDir?: string;
	readonly zoneId: string;
}

export interface ZoneBackupManager {
	createBackup(options: {
		readonly zoneId: string;
		readonly stateDir: string;
		readonly runtimeDir: string;
		readonly zoneFilesDir?: string;
		readonly backupDir: string;
	}): Promise<BackupResult>;

	restoreBackup(options: {
		readonly backupPath: string;
		readonly stateDir: string;
		readonly zoneFilesDir?: string;
	}): Promise<BackupRestoreResult>;

	listBackups(options: { readonly backupDir: string; readonly zoneId?: string }): BackupResult[];
}

/**
 * Archive layout inside the tar:
 *   state/       — contents of stateDir
 *   zone-files/  — contents of zoneFilesDir, when the gateway has durable zone files
 *   manifest.json
 *
 * This fixed layout decouples archive structure from host paths, so stateDir
 * and zoneFilesDir can live under completely different parents on restore.
 */
export function createZoneBackupManager(encryption: BackupEncryption): ZoneBackupManager {
	return {
		async createBackup(options) {
			return await createEncryptedBackup({
				encryption,
				backupDir: options.backupDir,
				runtimeDir: options.runtimeDir,
				stateDir: options.stateDir,
				...(options.zoneFilesDir !== undefined ? { zoneFilesDir: options.zoneFilesDir } : {}),
				zoneId: options.zoneId,
			});
		},
		async restoreBackup(options) {
			return await restoreEncryptedBackup({
				encryption,
				backupPath: options.backupPath,
				stateDir: options.stateDir,
				...(options.zoneFilesDir !== undefined ? { zoneFilesDir: options.zoneFilesDir } : {}),
			});
		},
		listBackups(options) {
			return listBackupArtifacts(options);
		},
	};
}
