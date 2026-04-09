import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Delimiter used in snapshot filenames to separate zoneId from timestamp.
 * Double underscore avoids collisions with hyphenated zone names like "shravan-lab".
 */
const SNAPSHOT_FILENAME_DELIMITER = '__';

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
export function createSnapshotManager(
	encryption: SnapshotEncryption,
): SnapshotManager {
	return {
		async createSnapshot(options) {
			const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
			const tarName = `${options.zoneId}${SNAPSHOT_FILENAME_DELIMITER}${timestamp}.tar`;
			const tarPath = path.join(options.snapshotDir, tarName);
			const encryptedPath = `${tarPath}.age`;

			fs.mkdirSync(options.snapshotDir, { recursive: true });

			// Build a staging directory with a canonical layout:
			//   staging/state/     -> contents of stateDir
			//   staging/workspace/ -> contents of workspaceDir
			//   staging/manifest.json
			const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-stage-'));
			try {
				const stagingStateDir = path.join(stagingDir, 'state');
				const stagingWorkspaceDir = path.join(stagingDir, 'workspace');

				await execFileAsync('cp', ['-a', options.stateDir, stagingStateDir]);
				await execFileAsync('cp', ['-a', options.workspaceDir, stagingWorkspaceDir]);

				fs.writeFileSync(
					path.join(stagingDir, 'manifest.json'),
					JSON.stringify({
						zoneId: options.zoneId,
						timestamp,
						createdAt: new Date().toISOString(),
					}),
				);

				await execFileAsync('tar', [
					'cf',
					tarPath,
					'-C',
					stagingDir,
					'state',
					'workspace',
					'manifest.json',
				]);
			} finally {
				fs.rmSync(stagingDir, { recursive: true, force: true });
			}

			await encryption.encrypt(tarPath, encryptedPath);

			// Clean up unencrypted tar
			fs.unlinkSync(tarPath);

			return {
				snapshotPath: encryptedPath,
				timestamp,
				zoneId: options.zoneId,
			};
		},

		async restoreSnapshot(options) {
			const tmpTar = `${options.snapshotPath}.decrypted.tar`;

			await encryption.decrypt(options.snapshotPath, tmpTar);

			// Extract into a temporary directory with the canonical layout,
			// then copy state/ and workspace/ to their target paths.
			const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-extract-'));
			try {
				await execFileAsync('tar', ['xf', tmpTar, '-C', extractDir]);

				// Read zoneId from the embedded manifest (reliable, no filename parsing)
				const manifestPath = path.join(extractDir, 'manifest.json');
				let zoneId = 'unknown';
				if (fs.existsSync(manifestPath)) {
					const manifest = JSON.parse(
						fs.readFileSync(manifestPath, 'utf8'),
					) as { zoneId?: string };
					zoneId = manifest.zoneId ?? 'unknown';
				}

				// Copy extracted state/ contents into the target stateDir
				const extractedStateDir = path.join(extractDir, 'state');
				if (fs.existsSync(extractedStateDir)) {
					const stateEntries = fs.readdirSync(extractedStateDir);
					for (const entry of stateEntries) {
						const sourcePath = path.join(extractedStateDir, entry);
						const destPath = path.join(options.stateDir, entry);
						await execFileAsync('cp', ['-a', sourcePath, destPath]);
					}
				}

				// Copy extracted workspace/ contents into the target workspaceDir
				const extractedWorkspaceDir = path.join(extractDir, 'workspace');
				if (fs.existsSync(extractedWorkspaceDir)) {
					const workspaceEntries = fs.readdirSync(extractedWorkspaceDir);
					for (const entry of workspaceEntries) {
						const sourcePath = path.join(extractedWorkspaceDir, entry);
						const destPath = path.join(options.workspaceDir, entry);
						await execFileAsync('cp', ['-a', sourcePath, destPath]);
					}
				}

				return {
					stateDir: options.stateDir,
					workspaceDir: options.workspaceDir,
					zoneId,
				};
			} finally {
				fs.rmSync(extractDir, { recursive: true, force: true });
				fs.unlinkSync(tmpTar);
			}
		},

		listSnapshots(options) {
			if (!fs.existsSync(options.snapshotDir)) {
				return [];
			}

			const files = fs
				.readdirSync(options.snapshotDir)
				.filter((file) => file.endsWith('.tar.age'));
			const filtered = options.zoneId
				? files.filter((file) =>
						file.startsWith(`${options.zoneId}${SNAPSHOT_FILENAME_DELIMITER}`),
					)
				: files;

			return filtered.map((file) => {
				const withoutExt = file.replace('.tar.age', '');
				const delimiterIndex = withoutExt.indexOf(SNAPSHOT_FILENAME_DELIMITER);
				const zoneId =
					delimiterIndex >= 0
						? withoutExt.slice(0, delimiterIndex)
						: withoutExt;
				const timestamp =
					delimiterIndex >= 0
						? withoutExt.slice(delimiterIndex + SNAPSHOT_FILENAME_DELIMITER.length)
						: '';
				return {
					snapshotPath: path.join(options.snapshotDir, file),
					timestamp,
					zoneId,
				};
			});
		},
	};
}
