import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { createEncryptedBackup } from './backup-create-operation.js';
import { restoreEncryptedBackup } from './backup-restore-operation.js';

const createdDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-backup-create-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

describe('createEncryptedBackup', () => {
	afterEach(async () => {
		await Promise.all(
			createdDirectories.splice(0).map(async (directoryPath) => {
				await rm(directoryPath, { recursive: true, force: true });
			}),
		);
	});

	it('does not expose whole-zone Git authority in backup creation options', () => {
		expectTypeOf<Parameters<typeof createEncryptedBackup>[0]>().not.toHaveProperty('zoneGit');
	});

	it('directly backs up and restores state and zone files without Git setup', async () => {
		const rootPath = await createTemporaryDirectory();
		const backupDir = path.join(rootPath, 'backups');
		const cacheDir = path.join(rootPath, 'cache');
		const controllerStateDir = path.join(rootPath, 'controller-state');
		const observabilityDir = path.join(rootPath, 'observability-data');
		const runtimeDir = path.join(rootPath, 'runtime');
		const stateDir = path.join(rootPath, 'state', 'sunfam');
		const zoneFilesDir = path.join(rootPath, 'zone-files', 'sunfam');
		await Promise.all(
			[
				backupDir,
				cacheDir,
				controllerStateDir,
				observabilityDir,
				runtimeDir,
				stateDir,
				zoneFilesDir,
			].map(async (directoryPath) => {
				await mkdir(directoryPath, { recursive: true });
			}),
		);
		await Promise.all([
			writeFile(path.join(backupDir, 'older.tar.age'), 'old backup\n'),
			writeFile(path.join(cacheDir, 'cache.bin'), 'cache\n'),
			writeFile(path.join(controllerStateDir, 'controller.json'), '{}\n'),
			writeFile(path.join(observabilityDir, 'telemetry.bin'), 'telemetry\n'),
			writeFile(path.join(runtimeDir, 'gateway.pid'), '123\n'),
			writeFile(path.join(stateDir, 'runtime.json'), '{}\n'),
			writeFile(path.join(zoneFilesDir, 'AGENTS.md'), 'zone files\n'),
		]);

		const backup = await createEncryptedBackup({
			backupDir,
			cacheDir,
			encryption: {
				decrypt: async () => {},
				encrypt: async (inputPath, outputPath) => {
					await copyFile(inputPath, outputPath);
				},
			},
			runtimeDir,
			stateDir,
			zoneFilesDir,
			zoneId: 'sunfam',
		});

		const tarListing = (await execa('tar', ['tf', backup.backupPath])).stdout;
		expect(tarListing).toContain('state/runtime.json');
		expect(tarListing).toContain('zone-files/AGENTS.md');
		expect(tarListing).not.toContain('backups/');
		expect(tarListing).not.toContain('cache/');
		expect(tarListing).not.toContain('controller-state/');
		expect(tarListing).not.toContain('observability-data/');
		expect(tarListing).not.toContain('runtime/');

		const restoredRootPath = await createTemporaryDirectory();
		const restoredStateDir = path.join(restoredRootPath, 'state');
		const restoredZoneFilesDir = path.join(restoredRootPath, 'zone-files');
		await Promise.all([
			mkdir(restoredStateDir, { recursive: true }),
			mkdir(restoredZoneFilesDir, { recursive: true }),
		]);
		const restoreResult = await restoreEncryptedBackup({
			backupPath: backup.backupPath,
			encryption: {
				decrypt: async (inputPath, outputPath) => {
					await copyFile(inputPath, outputPath);
				},
				encrypt: async () => {},
			},
			stateDir: restoredStateDir,
			zoneFilesDir: restoredZoneFilesDir,
		});

		expect(restoreResult).toEqual({
			stateDir: restoredStateDir,
			zoneFilesDir: restoredZoneFilesDir,
			zoneId: 'sunfam',
		});
		await expect(readFile(path.join(restoredStateDir, 'runtime.json'), 'utf8')).resolves.toBe(
			'{}\n',
		);
		await expect(readFile(path.join(restoredZoneFilesDir, 'AGENTS.md'), 'utf8')).resolves.toBe(
			'zone files\n',
		);
	});
});
