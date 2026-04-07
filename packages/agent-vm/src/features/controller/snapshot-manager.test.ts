import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSnapshotManager } from './snapshot-manager.js';

const noopEncryption = {
	encrypt: async (inputPath: string, outputPath: string): Promise<void> => {
		fs.copyFileSync(inputPath, outputPath);
	},
	decrypt: async (inputPath: string, outputPath: string): Promise<void> => {
		fs.copyFileSync(inputPath, outputPath);
	},
};

describe('createSnapshotManager', () => {
	let tmpDir: string | undefined;

	afterEach(() => {
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it('creates a tar archive of zone state and workspace dirs', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-create-'));
		const stateDir = path.join(tmpDir, 'state');
		const workspaceDir = path.join(tmpDir, 'workspace');
		const snapshotDir = path.join(tmpDir, 'snapshots');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(workspaceDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, 'session.json'), '{"token":"abc"}');
		fs.writeFileSync(path.join(workspaceDir, 'notes.txt'), 'hello');

		const manager = createSnapshotManager(noopEncryption);

		const result = await manager.createSnapshot({
			zoneId: 'shravan',
			stateDir,
			workspaceDir,
			snapshotDir,
		});

		expect(result.zoneId).toBe('shravan');
		expect(result.snapshotPath).toMatch(/shravan-\d{4}-\d{2}-\d{2}T.*\.tar\.age$/u);
		expect(fs.existsSync(result.snapshotPath)).toBe(true);
	});

	it('restores a snapshot to state and workspace dirs', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-restore-'));
		const stateDir = path.join(tmpDir, 'state');
		const workspaceDir = path.join(tmpDir, 'workspace');
		const snapshotDir = path.join(tmpDir, 'snapshots');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(workspaceDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, 'data.json'), '{"key":"val"}');
		fs.writeFileSync(path.join(workspaceDir, 'file.txt'), 'content');

		const manager = createSnapshotManager(noopEncryption);

		const snapshot = await manager.createSnapshot({
			zoneId: 'shravan',
			stateDir,
			workspaceDir,
			snapshotDir,
		});

		// Clear dirs to simulate a fresh machine
		fs.rmSync(stateDir, { recursive: true });
		fs.rmSync(workspaceDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(workspaceDir, { recursive: true });

		const restoreResult = await manager.restoreSnapshot({
			snapshotPath: snapshot.snapshotPath,
			stateDir,
			workspaceDir,
		});

		expect(restoreResult.zoneId).toBe('shravan');
		expect(fs.existsSync(path.join(stateDir, 'data.json'))).toBe(true);
		expect(fs.readFileSync(path.join(stateDir, 'data.json'), 'utf8')).toBe('{"key":"val"}');
		expect(fs.existsSync(path.join(workspaceDir, 'file.txt'))).toBe(true);
		expect(fs.readFileSync(path.join(workspaceDir, 'file.txt'), 'utf8')).toBe('content');
	});

	it('lists snapshots filtered by zone', () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-list-'));
		fs.writeFileSync(path.join(tmpDir, 'shravan-2026-04-06T10-00-00.tar.age'), '');
		fs.writeFileSync(path.join(tmpDir, 'shravan-2026-04-05T10-00-00.tar.age'), '');
		fs.writeFileSync(path.join(tmpDir, 'alevtina-2026-04-06T10-00-00.tar.age'), '');

		const manager = createSnapshotManager(noopEncryption);

		const all = manager.listSnapshots({ snapshotDir: tmpDir });
		expect(all).toHaveLength(3);

		const shravanOnly = manager.listSnapshots({ snapshotDir: tmpDir, zoneId: 'shravan' });
		expect(shravanOnly).toHaveLength(2);
		expect(shravanOnly.every((snapshot) => snapshot.zoneId === 'shravan')).toBe(true);
	});

	it('returns empty list for non-existent snapshot directory', () => {
		const manager = createSnapshotManager(noopEncryption);
		const result = manager.listSnapshots({ snapshotDir: '/tmp/does-not-exist-xyz' });
		expect(result).toEqual([]);
	});
});
