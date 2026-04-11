import { listSnapshotArtifacts } from './snapshot-archive-layout.js';
import { createEncryptedSnapshot } from './snapshot-create-operation.js';
import { restoreEncryptedSnapshot } from './snapshot-restore-operation.js';

export interface SnapshotEncryption {
	readonly encrypt: (inputPath: string, outputPath: string) => Promise<void>;
	readonly decrypt: (inputPath: string, outputPath: string) => Promise<void>;
}

export interface SnapshotResult {
	readonly snapshotPath: string;
	readonly timestamp: string;
	readonly zoneId: string;
}

export interface RestoreResult {
	readonly stateDir: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}

export interface SnapshotManager {
	createSnapshot(options: {
		readonly zoneId: string;
		readonly stateDir: string;
		readonly workspaceDir: string;
		readonly snapshotDir: string;
	}): Promise<SnapshotResult>;

	restoreSnapshot(options: {
		readonly snapshotPath: string;
		readonly stateDir: string;
		readonly workspaceDir: string;
	}): Promise<RestoreResult>;

	listSnapshots(options: {
		readonly snapshotDir: string;
		readonly zoneId?: string;
	}): SnapshotResult[];
}

/**
 * Archive layout inside the tar:
 *   state/      — contents of stateDir
 *   workspace/  — contents of workspaceDir
 *   manifest.json
 *
 * This fixed layout decouples archive structure from host paths, so stateDir
 * and workspaceDir can live under completely different parents on restore.
 */
export function createSnapshotManager(encryption: SnapshotEncryption): SnapshotManager {
	return {
		async createSnapshot(options) {
			return await createEncryptedSnapshot({
				encryption,
				snapshotDir: options.snapshotDir,
				stateDir: options.stateDir,
				workspaceDir: options.workspaceDir,
				zoneId: options.zoneId,
			});
		},
		async restoreSnapshot(options) {
			return await restoreEncryptedSnapshot({
				encryption,
				snapshotPath: options.snapshotPath,
				stateDir: options.stateDir,
				workspaceDir: options.workspaceDir,
			});
		},
		listSnapshots(options) {
			return listSnapshotArtifacts(options);
		},
	};
}
