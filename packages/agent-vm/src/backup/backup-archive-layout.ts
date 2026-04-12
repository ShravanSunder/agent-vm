import fs from 'node:fs';
import path from 'node:path';

import type { BackupResult } from './backup-manager.js';

export const BACKUP_FILENAME_DELIMITER = '__';

export function buildBackupPaths(options: {
	readonly backupDir: string;
	readonly timestamp: string;
	readonly zoneId: string;
}): {
	readonly encryptedPath: string;
	readonly tarPath: string;
} {
	const tarName = `${options.zoneId}${BACKUP_FILENAME_DELIMITER}${options.timestamp}.tar`;
	const tarPath = path.join(options.backupDir, tarName);
	return {
		encryptedPath: `${tarPath}.age`,
		tarPath,
	};
}

export function listBackupArtifacts(options: {
	readonly backupDir: string;
	readonly zoneId?: string;
}): BackupResult[] {
	if (!fs.existsSync(options.backupDir)) {
		return [];
	}

	const backupFiles = fs
		.readdirSync(options.backupDir)
		.filter((fileName) => fileName.endsWith('.tar.age'));
	const filteredFiles = options.zoneId
		? backupFiles.filter((fileName) =>
				fileName.startsWith(`${options.zoneId}${BACKUP_FILENAME_DELIMITER}`),
			)
		: backupFiles;

	return filteredFiles.map((fileName) => {
		const fileStem = fileName.replace('.tar.age', '');
		const delimiterIndex = fileStem.indexOf(BACKUP_FILENAME_DELIMITER);
		return {
			backupPath: path.join(options.backupDir, fileName),
			timestamp:
				delimiterIndex >= 0
					? fileStem.slice(delimiterIndex + BACKUP_FILENAME_DELIMITER.length)
					: '',
			zoneId: delimiterIndex >= 0 ? fileStem.slice(0, delimiterIndex) : fileStem,
		};
	});
}
