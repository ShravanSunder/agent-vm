import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export function createSnapshotManager(
	encryption: SnapshotEncryption,
): SnapshotManager {
	return {
		async createSnapshot(options) {
			const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
			const tarName = `${options.zoneId}-${timestamp}.tar`;
			const tarPath = path.join(options.snapshotDir, tarName);
			const encryptedPath = `${tarPath}.age`;

			fs.mkdirSync(options.snapshotDir, { recursive: true });

			// Write manifest alongside archive contents
			const manifestPath = path.join(options.snapshotDir, 'manifest.json');
			fs.writeFileSync(
				manifestPath,
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
				path.dirname(options.stateDir),
				path.basename(options.stateDir),
				'-C',
				path.dirname(options.workspaceDir),
				path.basename(options.workspaceDir),
				'-C',
				options.snapshotDir,
				'manifest.json',
			]);

			await encryption.encrypt(tarPath, encryptedPath);

			// Clean up unencrypted tar and manifest
			fs.unlinkSync(tarPath);
			fs.unlinkSync(manifestPath);

			return {
				snapshotPath: encryptedPath,
				timestamp,
				zoneId: options.zoneId,
			};
		},

		async restoreSnapshot(options) {
			const tmpTar = `${options.snapshotPath}.decrypted.tar`;

			await encryption.decrypt(options.snapshotPath, tmpTar);

			const extractDir = path.dirname(options.stateDir);
			await execFileAsync('tar', ['xf', tmpTar, '-C', extractDir]);

			fs.unlinkSync(tmpTar);

			const snapshotFileName = path.basename(options.snapshotPath);
			const zoneId = snapshotFileName.split('-')[0] ?? 'unknown';

			return {
				stateDir: options.stateDir,
				workspaceDir: options.workspaceDir,
				zoneId,
			};
		},

		listSnapshots(options) {
			if (!fs.existsSync(options.snapshotDir)) {
				return [];
			}

			const files = fs
				.readdirSync(options.snapshotDir)
				.filter((file) => file.endsWith('.tar.age'));
			const filtered = options.zoneId
				? files.filter((file) => file.startsWith(`${options.zoneId}-`))
				: files;

			return filtered.map((file) => {
				const withoutExt = file.replace('.tar.age', '');
				const firstDash = withoutExt.indexOf('-');
				const zoneId = firstDash >= 0 ? withoutExt.slice(0, firstDash) : withoutExt;
				const timestamp = firstDash >= 0 ? withoutExt.slice(firstDash + 1) : '';
				return {
					snapshotPath: path.join(options.snapshotDir, file),
					timestamp,
					zoneId,
				};
			});
		},
	};
}
