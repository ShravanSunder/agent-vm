import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import {
	ensureZoneGitRepository,
	pushZoneGit,
} from '../controller/zone-git/zone-git-operations.js';
import { resolveZoneGitPaths } from '../controller/zone-git/zone-git-paths.js';
import { createEncryptedBackup } from './backup-create-operation.js';
import { restoreEncryptedBackup } from './backup-restore-operation.js';

const createdDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-backup-zone-git-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function buildHostGitArgs(props: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly workTree: string;
}): readonly string[] {
	return [`--git-dir=${props.gitDir}`, `--work-tree=${props.workTree}`, ...props.args];
}

async function configureGitUser(props: {
	readonly gitDir: string;
	readonly workTree: string;
}): Promise<void> {
	await execa('git', buildHostGitArgs({ ...props, args: ['config', 'user.name', 'Agent VM'] }));
	await execa(
		'git',
		buildHostGitArgs({ ...props, args: ['config', 'user.email', 'agent-vm@example.com'] }),
	);
}

async function commitZoneFiles(props: {
	readonly gitDir: string;
	readonly message: string;
	readonly workTree: string;
}): Promise<string> {
	await execa('git', buildHostGitArgs({ ...props, args: ['add', '.'] }));
	await execa('git', buildHostGitArgs({ ...props, args: ['commit', '-m', props.message] }));
	return (
		await execa('git', buildHostGitArgs({ ...props, args: ['rev-parse', 'HEAD'] }))
	).stdout.trim();
}

async function createZoneGitFixture(): Promise<{
	readonly backupDir: string;
	readonly cacheDir: string;
	readonly gitDir: string;
	readonly remoteUrl: string;
	readonly runtimeDir: string;
	readonly stateDir: string;
	readonly zoneFilesDir: string;
}> {
	const rootPath = await createTemporaryDirectory();
	const backupDir = path.join(rootPath, 'backups');
	const cacheDir = path.join(rootPath, 'cache');
	const remoteUrl = path.join(rootPath, 'remote.git');
	const runtimeDir = path.join(rootPath, 'runtime');
	const stateDir = path.join(rootPath, 'state', 'sunfam');
	const zoneFilesDir = path.join(rootPath, 'zone-files', 'sunfam');
	await mkdir(stateDir, { recursive: true });
	await mkdir(zoneFilesDir, { recursive: true });
	await writeFile(path.join(stateDir, 'runtime.json'), '{}\n');
	await execa('git', ['init', '--bare', remoteUrl]);
	await ensureZoneGitRepository({
		branch: 'main',
		remoteUrl,
		runtimeDir,
		zoneFilesDir,
		zoneId: 'sunfam',
	});
	const gitDir = resolveZoneGitPaths({ runtimeDir, zoneId: 'sunfam' }).hostGitDir;
	await configureGitUser({ gitDir, workTree: zoneFilesDir });
	return { backupDir, cacheDir, gitDir, remoteUrl, runtimeDir, stateDir, zoneFilesDir };
}

describe('createEncryptedBackup zone Git guardrails', () => {
	afterEach(async () => {
		await Promise.all(
			createdDirectories.splice(0).map(async (directoryPath) => {
				await rm(directoryPath, { recursive: true, force: true });
			}),
		);
	});

	it('rejects dirty zone Git worktrees before backup', async () => {
		const fixture = await createZoneGitFixture();
		await writeFile(path.join(fixture.zoneFilesDir, 'AGENTS.md'), 'dirty\n');

		await expect(
			createEncryptedBackup({
				backupDir: fixture.backupDir,
				cacheDir: fixture.cacheDir,
				encryption: { decrypt: async () => {}, encrypt: async () => {} },
				runtimeDir: fixture.runtimeDir,
				stateDir: fixture.stateDir,
				zoneFilesDir: fixture.zoneFilesDir,
				zoneGit: {
					branch: 'main',
					remoteUrl: fixture.remoteUrl,
					runtimeDir: fixture.runtimeDir,
					zoneFilesDir: fixture.zoneFilesDir,
					zoneId: 'sunfam',
				},
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(/uncommitted zone Git changes/u);
	});

	it('rejects unpushed zone Git commits before backup', async () => {
		const fixture = await createZoneGitFixture();
		await writeFile(path.join(fixture.zoneFilesDir, 'AGENTS.md'), 'committed\n');
		await commitZoneFiles({
			gitDir: fixture.gitDir,
			message: 'docs: seed zone files',
			workTree: fixture.zoneFilesDir,
		});

		await expect(
			createEncryptedBackup({
				backupDir: fixture.backupDir,
				cacheDir: fixture.cacheDir,
				encryption: { decrypt: async () => {}, encrypt: async () => {} },
				runtimeDir: fixture.runtimeDir,
				stateDir: fixture.stateDir,
				zoneFilesDir: fixture.zoneFilesDir,
				zoneGit: {
					branch: 'main',
					remoteUrl: fixture.remoteUrl,
					runtimeDir: fixture.runtimeDir,
					zoneFilesDir: fixture.zoneFilesDir,
					zoneId: 'sunfam',
				},
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(/unpushed zone Git commit/u);
	});

	it('backs up clean pushed zone files without copying runtime Git metadata', async () => {
		const fixture = await createZoneGitFixture();
		await writeFile(path.join(fixture.zoneFilesDir, 'AGENTS.md'), 'committed\n');
		const localHead = await commitZoneFiles({
			gitDir: fixture.gitDir,
			message: 'docs: seed zone files',
			workTree: fixture.zoneFilesDir,
		});
		await pushZoneGit({
			branch: 'main',
			expectedHead: localHead,
			remoteUrl: fixture.remoteUrl,
			runtimeDir: fixture.runtimeDir,
			zoneFilesDir: fixture.zoneFilesDir,
			zoneId: 'sunfam',
		});

		const result = await createEncryptedBackup({
			backupDir: fixture.backupDir,
			cacheDir: fixture.cacheDir,
			encryption: {
				decrypt: async () => {},
				encrypt: async (inputPath, outputPath) => {
					await copyFile(inputPath, outputPath);
				},
			},
			runtimeDir: fixture.runtimeDir,
			stateDir: fixture.stateDir,
			zoneFilesDir: fixture.zoneFilesDir,
			zoneGit: {
				branch: 'main',
				remoteUrl: fixture.remoteUrl,
				runtimeDir: fixture.runtimeDir,
				zoneFilesDir: fixture.zoneFilesDir,
				zoneId: 'sunfam',
			},
			zoneId: 'sunfam',
		});

		const tarListing = (await execa('tar', ['tf', result.backupPath])).stdout;
		expect(tarListing).toContain('zone-files/AGENTS.md');
		expect(tarListing).not.toContain('zone-files.git');
		expect(tarListing).not.toContain('runtime/');

		const restoredRootPath = await createTemporaryDirectory();
		const restoredRuntimeDir = path.join(restoredRootPath, 'runtime');
		const restoredStateDir = path.join(restoredRootPath, 'state', 'sunfam');
		const restoredZoneFilesDir = path.join(restoredRootPath, 'zone-files', 'sunfam');
		await mkdir(restoredStateDir, { recursive: true });
		await mkdir(restoredZoneFilesDir, { recursive: true });
		await restoreEncryptedBackup({
			backupPath: result.backupPath,
			encryption: {
				decrypt: async (inputPath, outputPath) => {
					await copyFile(inputPath, outputPath);
				},
				encrypt: async () => {},
			},
			stateDir: restoredStateDir,
			zoneFilesDir: restoredZoneFilesDir,
		});

		await expect(
			ensureZoneGitRepository({
				branch: 'main',
				remoteUrl: fixture.remoteUrl,
				runtimeDir: restoredRuntimeDir,
				zoneFilesDir: restoredZoneFilesDir,
				zoneId: 'sunfam',
			}),
		).resolves.toBeUndefined();
	});
});
