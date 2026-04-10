import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildSnapshotPaths } from './snapshot-archive-layout.js';
import type { SnapshotEncryption, SnapshotResult } from './snapshot-manager.js';

const execFileAsync = promisify(execFile);

export async function createEncryptedSnapshot(options: {
	readonly encryption: SnapshotEncryption;
	readonly snapshotDir: string;
	readonly stateDir: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}): Promise<SnapshotResult> {
	const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
	const snapshotPaths = buildSnapshotPaths({
		snapshotDir: options.snapshotDir,
		timestamp,
		zoneId: options.zoneId,
	});

	fs.mkdirSync(options.snapshotDir, { recursive: true });

	const stagingDirectory = fs.mkdtempSync(
		path.join(os.tmpdir(), 'snapshot-stage-'),
	);
	try {
		await execFileAsync('cp', [
			'-a',
			options.stateDir,
			path.join(stagingDirectory, 'state'),
		]);
		await execFileAsync('cp', [
			'-a',
			options.workspaceDir,
			path.join(stagingDirectory, 'workspace'),
		]);

		fs.writeFileSync(
			path.join(stagingDirectory, 'manifest.json'),
			JSON.stringify({
				createdAt: new Date().toISOString(),
				timestamp,
				zoneId: options.zoneId,
			}),
		);

		await execFileAsync('tar', [
			'cf',
			snapshotPaths.tarPath,
			'-C',
			stagingDirectory,
			'state',
			'workspace',
			'manifest.json',
		]);
	} finally {
		fs.rmSync(stagingDirectory, { recursive: true, force: true });
	}

	await options.encryption.encrypt(
		snapshotPaths.tarPath,
		snapshotPaths.encryptedPath,
	);
	fs.unlinkSync(snapshotPaths.tarPath);

	return {
		snapshotPath: snapshotPaths.encryptedPath,
		timestamp,
		zoneId: options.zoneId,
	};
}
