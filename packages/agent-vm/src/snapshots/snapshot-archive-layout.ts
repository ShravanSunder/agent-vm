import fs from 'node:fs';
import path from 'node:path';

import type { SnapshotResult } from './snapshot-manager.js';

export const SNAPSHOT_FILENAME_DELIMITER = '__';

export function buildSnapshotPaths(options: {
	readonly snapshotDir: string;
	readonly timestamp: string;
	readonly zoneId: string;
}): {
	readonly encryptedPath: string;
	readonly tarPath: string;
} {
	const tarName = `${options.zoneId}${SNAPSHOT_FILENAME_DELIMITER}${options.timestamp}.tar`;
	const tarPath = path.join(options.snapshotDir, tarName);
	return {
		encryptedPath: `${tarPath}.age`,
		tarPath,
	};
}

export function listSnapshotArtifacts(options: {
	readonly snapshotDir: string;
	readonly zoneId?: string;
}): SnapshotResult[] {
	if (!fs.existsSync(options.snapshotDir)) {
		return [];
	}

	const snapshotFiles = fs
		.readdirSync(options.snapshotDir)
		.filter((fileName) => fileName.endsWith('.tar.age'));
	const filteredFiles = options.zoneId
		? snapshotFiles.filter((fileName) =>
				fileName.startsWith(`${options.zoneId}${SNAPSHOT_FILENAME_DELIMITER}`),
			)
		: snapshotFiles;

	return filteredFiles.map((fileName) => {
		const fileStem = fileName.replace('.tar.age', '');
		const delimiterIndex = fileStem.indexOf(SNAPSHOT_FILENAME_DELIMITER);
		return {
			snapshotPath: path.join(options.snapshotDir, fileName),
			timestamp:
				delimiterIndex >= 0
					? fileStem.slice(delimiterIndex + SNAPSHOT_FILENAME_DELIMITER.length)
					: '',
			zoneId: delimiterIndex >= 0 ? fileStem.slice(0, delimiterIndex) : fileStem,
		};
	});
}
