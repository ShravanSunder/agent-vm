import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createZoneBackupManager } from './backup-manager.js';

const noopEncryption = {
	encrypt: async (inputPath: string, outputPath: string): Promise<void> => {
		fs.copyFileSync(inputPath, outputPath);
	},
	decrypt: async (inputPath: string, outputPath: string): Promise<void> => {
		fs.copyFileSync(inputPath, outputPath);
	},
};

describe('createZoneBackupManager', () => {
	let tmpDir: string | undefined;

	afterEach(() => {
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it('creates a tar archive of zone state and zone files dirs', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-create-'));
		const stateDir = path.join(tmpDir, 'state');
		const zoneFilesDir = path.join(tmpDir, 'zone-files');
		const backupDir = path.join(tmpDir, 'backups');
		const runtimeDir = path.join(tmpDir, 'runtime');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, 'session.json'), '{"token":"abc"}');
		fs.writeFileSync(path.join(zoneFilesDir, 'notes.txt'), 'hello');

		const manager = createZoneBackupManager(noopEncryption);

		const result = await manager.createBackup({
			zoneId: 'shravan',
			stateDir,
			zoneFilesDir,
			backupDir,
			runtimeDir,
		});

		expect(result.zoneId).toBe('shravan');
		expect(result.backupPath).toMatch(/shravan__\d{4}-\d{2}-\d{2}T.*\.tar\.age$/u);
		expect(fs.existsSync(result.backupPath)).toBe(true);
	});

	it('rejects backups when runtimeDir overlaps backup-copied paths', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-runtime-overlap-'));
		const stateDir = path.join(tmpDir, 'state');
		const zoneFilesDir = path.join(tmpDir, 'zone-files');
		const backupDir = path.join(tmpDir, 'backups');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });

		const manager = createZoneBackupManager(noopEncryption);

		await expect(
			manager.createBackup({
				zoneId: 'shravan',
				stateDir,
				zoneFilesDir,
				backupDir,
				runtimeDir: path.join(stateDir, 'worker-tasks'),
			}),
		).rejects.toThrow(/runtimeDir.*stateDir/u);
		await expect(
			manager.createBackup({
				zoneId: 'shravan',
				stateDir,
				zoneFilesDir,
				backupDir,
				runtimeDir: path.join(zoneFilesDir, 'runtime'),
			}),
		).rejects.toThrow(/runtimeDir.*zoneFilesDir/u);
		await expect(
			manager.createBackup({
				zoneId: 'shravan',
				stateDir: path.join(tmpDir, 'runtime', 'state'),
				zoneFilesDir,
				backupDir,
				runtimeDir: path.join(tmpDir, 'runtime'),
			}),
		).rejects.toThrow(/runtimeDir.*stateDir/u);
		await expect(
			manager.createBackup({
				zoneId: 'shravan',
				stateDir,
				zoneFilesDir: path.join(tmpDir, 'runtime', 'zone-files'),
				backupDir,
				runtimeDir: path.join(tmpDir, 'runtime'),
			}),
		).rejects.toThrow(/runtimeDir.*zoneFilesDir/u);
	});

	it('restores a backup to state and zone-files dirs', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-'));
		const stateDir = path.join(tmpDir, 'state');
		const zoneFilesDir = path.join(tmpDir, 'zone-files');
		const backupDir = path.join(tmpDir, 'backups');
		const runtimeDir = path.join(tmpDir, 'runtime');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, 'data.json'), '{"key":"val"}');
		fs.writeFileSync(path.join(zoneFilesDir, 'file.txt'), 'content');

		const manager = createZoneBackupManager(noopEncryption);

		const backup = await manager.createBackup({
			zoneId: 'shravan',
			stateDir,
			zoneFilesDir,
			backupDir,
			runtimeDir,
		});

		// Clear dirs to simulate a fresh machine
		fs.rmSync(stateDir, { recursive: true });
		fs.rmSync(zoneFilesDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });

		const restoreResult = await manager.restoreBackup({
			backupPath: backup.backupPath,
			stateDir,
			zoneFilesDir,
		});

		expect(restoreResult.zoneId).toBe('shravan');
		expect(fs.existsSync(path.join(stateDir, 'data.json'))).toBe(true);
		expect(fs.readFileSync(path.join(stateDir, 'data.json'), 'utf8')).toBe('{"key":"val"}');
		expect(fs.existsSync(path.join(zoneFilesDir, 'file.txt'))).toBe(true);
		expect(fs.readFileSync(path.join(zoneFilesDir, 'file.txt'), 'utf8')).toBe('content');
	});

	it('restores state and zone-files to different parent directories', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cross-parent-'));

		// Create source dirs under different parents
		const sourceStateDir = path.join(tmpDir, 'parent-a', 'zone-state');
		const sourceZoneFilesDir = path.join(tmpDir, 'parent-b', 'zone-zone-files');
		const backupDir = path.join(tmpDir, 'backups');
		const runtimeDir = path.join(tmpDir, 'runtime');
		fs.mkdirSync(sourceStateDir, { recursive: true });
		fs.mkdirSync(sourceZoneFilesDir, { recursive: true });
		fs.writeFileSync(path.join(sourceStateDir, 'state-file.json'), '{"s":1}');
		fs.writeFileSync(path.join(sourceZoneFilesDir, 'zone-file.txt'), 'zone-files-data');

		const manager = createZoneBackupManager(noopEncryption);

		const backup = await manager.createBackup({
			zoneId: 'shravan-lab',
			stateDir: sourceStateDir,
			zoneFilesDir: sourceZoneFilesDir,
			backupDir,
			runtimeDir,
		});

		// Restore to completely different parents
		const restoreStateDir = path.join(tmpDir, 'restore-x', 'my-state');
		const restoreZoneFilesDir = path.join(tmpDir, 'restore-y', 'my-zone-files');
		fs.mkdirSync(restoreStateDir, { recursive: true });
		fs.mkdirSync(restoreZoneFilesDir, { recursive: true });

		const restoreResult = await manager.restoreBackup({
			backupPath: backup.backupPath,
			stateDir: restoreStateDir,
			zoneFilesDir: restoreZoneFilesDir,
		});

		expect(restoreResult.zoneId).toBe('shravan-lab');

		// State files land in the target stateDir, not leaked elsewhere
		expect(fs.existsSync(path.join(restoreStateDir, 'state-file.json'))).toBe(true);
		expect(fs.readFileSync(path.join(restoreStateDir, 'state-file.json'), 'utf8')).toBe('{"s":1}');

		// Zone files land in the target zoneFilesDir
		expect(fs.existsSync(path.join(restoreZoneFilesDir, 'zone-file.txt'))).toBe(true);
		expect(fs.readFileSync(path.join(restoreZoneFilesDir, 'zone-file.txt'), 'utf8')).toBe(
			'zone-files-data',
		);

		// Nothing leaked into sibling directories
		expect(fs.readdirSync(path.join(tmpDir, 'restore-x'))).toEqual(['my-state']);
		expect(fs.readdirSync(path.join(tmpDir, 'restore-y'))).toEqual(['my-zone-files']);
	});

	it('lists backups filtered by zone using double-underscore delimiter', () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-list-'));
		fs.writeFileSync(path.join(tmpDir, 'shravan__2026-04-06T10-00-00.tar.age'), '');
		fs.writeFileSync(path.join(tmpDir, 'shravan__2026-04-05T10-00-00.tar.age'), '');
		fs.writeFileSync(path.join(tmpDir, 'alevtina__2026-04-06T10-00-00.tar.age'), '');

		const manager = createZoneBackupManager(noopEncryption);

		const all = manager.listBackups({ backupDir: tmpDir });
		expect(all).toHaveLength(3);

		const shravanOnly = manager.listBackups({ backupDir: tmpDir, zoneId: 'shravan' });
		expect(shravanOnly).toHaveLength(2);
		expect(shravanOnly.every((backup) => backup.zoneId === 'shravan')).toBe(true);
	});

	it('correctly parses hyphenated zone names in filenames', () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-hyphen-'));
		fs.writeFileSync(path.join(tmpDir, 'shravan-lab__2026-04-06T10-00-00.tar.age'), '');
		fs.writeFileSync(path.join(tmpDir, 'shravan__2026-04-06T10-00-00.tar.age'), '');

		const manager = createZoneBackupManager(noopEncryption);

		const shravanLabOnly = manager.listBackups({
			backupDir: tmpDir,
			zoneId: 'shravan-lab',
		});
		expect(shravanLabOnly).toHaveLength(1);
		expect(shravanLabOnly[0]?.zoneId).toBe('shravan-lab');
		expect(shravanLabOnly[0]?.timestamp).toBe('2026-04-06T10-00-00');

		const shravanOnly = manager.listBackups({
			backupDir: tmpDir,
			zoneId: 'shravan',
		});
		expect(shravanOnly).toHaveLength(1);
		expect(shravanOnly[0]?.zoneId).toBe('shravan');
	});

	it('reads zoneId from manifest on restore instead of parsing filename', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-manifest-zone-'));
		const stateDir = path.join(tmpDir, 'state');
		const zoneFilesDir = path.join(tmpDir, 'zone-files');
		const backupDir = path.join(tmpDir, 'backups');
		const runtimeDir = path.join(tmpDir, 'runtime');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, 'a.json'), '{}');
		fs.writeFileSync(path.join(zoneFilesDir, 'b.txt'), 'b');

		const manager = createZoneBackupManager(noopEncryption);

		const backup = await manager.createBackup({
			zoneId: 'my-hyphenated-zone',
			stateDir,
			zoneFilesDir,
			backupDir,
			runtimeDir,
		});

		// Clear and restore
		fs.rmSync(stateDir, { recursive: true });
		fs.rmSync(zoneFilesDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });

		const restoreResult = await manager.restoreBackup({
			backupPath: backup.backupPath,
			stateDir,
			zoneFilesDir,
		});

		// zoneId comes from embedded manifest, not filename parsing
		expect(restoreResult.zoneId).toBe('my-hyphenated-zone');
	});

	it('returns empty list for non-existent backup directory', () => {
		const manager = createZoneBackupManager(noopEncryption);
		const result = manager.listBackups({ backupDir: '/tmp/does-not-exist-xyz' });
		expect(result).toEqual([]);
	});
});
