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

	it('backs up the production nested state and agent workspace layout without runtime Git or prior archives', async () => {
		const rootPath = await createTemporaryDirectory();
		const cacheDir = path.join(rootPath, 'cache');
		const controllerStateDir = path.join(rootPath, 'controller-state');
		const observabilityDir = path.join(rootPath, 'observability-data');
		const runtimeDir = path.join(rootPath, 'runtime');
		const stateDir = path.join(rootPath, 'state', 'sunfam');
		const backupDir = path.join(stateDir, 'backups');
		const zoneFilesDir = path.join(rootPath, 'zone-files', 'sunfam');
		const frameworkStateDir = path.join(stateDir, 'agents', 'alice', 'agent');
		const firstAgentWorkspaceDir = path.join(zoneFilesDir, 'agents', 'alice');
		const secondAgentWorkspaceDir = path.join(zoneFilesDir, 'agents', 'bob');
		const runtimeWorkspaceGitDir = path.join(
			runtimeDir,
			'zones',
			'sunfam',
			'gitdirs',
			'agents',
			'alice',
			'workspace.git',
		);
		await Promise.all(
			[
				backupDir,
				cacheDir,
				controllerStateDir,
				firstAgentWorkspaceDir,
				frameworkStateDir,
				observabilityDir,
				runtimeDir,
				runtimeWorkspaceGitDir,
				secondAgentWorkspaceDir,
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
			writeFile(
				path.join(stateDir, 'agents', 'alice', 'agent', 'auth-profiles.json'),
				'{"profile":"alice"}\n',
			),
			writeFile(path.join(stateDir, 'backups-metadata.json'), '{"retention":3}\n'),
			writeFile(path.join(observabilityDir, 'telemetry.bin'), 'telemetry\n'),
			writeFile(path.join(runtimeDir, 'gateway.pid'), '123\n'),
			writeFile(path.join(runtimeWorkspaceGitDir, 'HEAD'), 'ref: refs/heads/main\n'),
			writeFile(path.join(firstAgentWorkspaceDir, '.git'), 'gitdir: /gitdirs/workspace.git\n'),
			writeFile(path.join(firstAgentWorkspaceDir, 'AGENTS.md'), 'alice workspace\n'),
			writeFile(path.join(secondAgentWorkspaceDir, '.git'), 'gitdir: /gitdirs/workspace.git\n'),
			writeFile(path.join(secondAgentWorkspaceDir, 'NOTES.md'), 'bob workspace\n'),
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
		expect(tarListing).toContain('state/agents/alice/agent/auth-profiles.json');
		expect(tarListing).toContain('state/backups-metadata.json');
		expect(tarListing).toContain('zone-files/agents/alice/.git');
		expect(tarListing).toContain('zone-files/agents/alice/AGENTS.md');
		expect(tarListing).toContain('zone-files/agents/bob/.git');
		expect(tarListing).toContain('zone-files/agents/bob/NOTES.md');
		expect(tarListing).not.toContain('state/backups/');
		expect(tarListing).not.toContain('cache/');
		expect(tarListing).not.toContain('controller-state/');
		expect(tarListing).not.toContain('observability-data/');
		expect(tarListing).not.toContain('workspace.git/');
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
		await expect(
			readFile(
				path.join(restoredStateDir, 'agents', 'alice', 'agent', 'auth-profiles.json'),
				'utf8',
			),
		).resolves.toBe('{"profile":"alice"}\n');
		await expect(
			readFile(path.join(restoredZoneFilesDir, 'agents', 'alice', '.git'), 'utf8'),
		).resolves.toBe('gitdir: /gitdirs/workspace.git\n');
		await expect(
			readFile(path.join(restoredZoneFilesDir, 'agents', 'alice', 'AGENTS.md'), 'utf8'),
		).resolves.toBe('alice workspace\n');
		await expect(
			readFile(path.join(restoredZoneFilesDir, 'agents', 'bob', '.git'), 'utf8'),
		).resolves.toBe('gitdir: /gitdirs/workspace.git\n');
		await expect(
			readFile(path.join(restoredZoneFilesDir, 'agents', 'bob', 'NOTES.md'), 'utf8'),
		).resolves.toBe('bob workspace\n');
	});
});
