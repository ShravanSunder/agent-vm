import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureZoneGitRepository, getZoneGitStatus, pushZoneGit } from './zone-git-operations.js';
import { resolveZoneGitPaths } from './zone-git-paths.js';

const createdDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
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
	await execa(
		'git',
		buildHostGitArgs({
			...props,
			args: ['config', 'user.email', 'agent-vm@example.com'],
		}),
	);
	await execa(
		'git',
		buildHostGitArgs({
			...props,
			args: ['config', 'user.name', 'Agent VM'],
		}),
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

describe('zone-git-operations', () => {
	afterEach(async () => {
		await Promise.all(
			createdDirectories.splice(0).map(async (directoryPath) => {
				await rm(directoryPath, { recursive: true, force: true });
			}),
		);
	});

	it('initializes split zone Git metadata under runtimeDir and writes a VM-visible gitdir pointer', async () => {
		const rootPath = await createTemporaryDirectory();
		const runtimeDir = path.join(rootPath, 'runtime');
		const zoneFilesDir = path.join(rootPath, 'zone-files', 'sunfam');
		const remoteUrl = path.join(rootPath, 'remote.git');
		await mkdir(zoneFilesDir, { recursive: true });
		await writeFile(path.join(zoneFilesDir, 'AGENTS.md'), 'commit and use zone_git_push\n');
		await execa('git', ['init', '--bare', remoteUrl]);

		await ensureZoneGitRepository({
			branch: 'main',
			remoteUrl,
			runtimeDir,
			zoneFilesDir,
			zoneId: 'sunfam',
		});

		await expect(readFile(path.join(zoneFilesDir, '.git'), 'utf8')).resolves.toBe(
			'gitdir: /agent-vm/zone-git/zone-files.git\n',
		);
		await expect(
			stat(path.join(runtimeDir, 'zones', 'sunfam', 'zone-git', 'zone-files.git')),
		).resolves.toBeTruthy();
	});

	it('reports dirty and ahead state before and after controller push', async () => {
		const rootPath = await createTemporaryDirectory();
		const runtimeDir = path.join(rootPath, 'runtime');
		const zoneFilesDir = path.join(rootPath, 'zone-files', 'sunfam');
		const remoteUrl = path.join(rootPath, 'remote.git');
		await mkdir(zoneFilesDir, { recursive: true });
		await writeFile(path.join(zoneFilesDir, 'AGENTS.md'), 'initial\n');
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

		const dirtyStatus = await getZoneGitStatus({
			branch: 'main',
			remoteUrl,
			runtimeDir,
			zoneFilesDir,
			zoneId: 'sunfam',
		});

		expect(dirtyStatus).toMatchObject({
			initialized: true,
			dirty: true,
			aheadOfRemote: 0,
			behindRemote: 0,
			remoteHead: null,
		});

		const localHead = await commitZoneFiles({
			gitDir,
			message: 'docs: seed zone files',
			workTree: zoneFilesDir,
		});

		const aheadStatus = await getZoneGitStatus({
			branch: 'main',
			remoteUrl,
			runtimeDir,
			zoneFilesDir,
			zoneId: 'sunfam',
		});

		expect(aheadStatus).toMatchObject({
			initialized: true,
			dirty: false,
			aheadOfRemote: 1,
			behindRemote: 0,
			localHead,
			remoteHead: null,
		});

		const pushResult = await pushZoneGit({
			branch: 'main',
			expectedHead: localHead,
			remoteUrl,
			runtimeDir,
			zoneFilesDir,
			zoneId: 'sunfam',
		});

		expect(pushResult).toMatchObject({
			branch: 'main',
			success: true,
			localHead,
			remoteHead: localHead,
		});
		expect(pushResult.pushedCommits).toEqual([
			{
				sha: localHead,
				subject: 'docs: seed zone files',
			},
		]);
		expect(
			(await execa('git', ['--git-dir', remoteUrl, 'rev-parse', 'refs/heads/main'])).stdout.trim(),
		).toBe(localHead);

		await expect(
			getZoneGitStatus({
				branch: 'main',
				remoteUrl,
				runtimeDir,
				zoneFilesDir,
				zoneId: 'sunfam',
			}),
		).resolves.toMatchObject({
			aheadOfRemote: 0,
			remoteHead: localHead,
		});
	});

	it('rejects pushes when expectedHead does not match the local head', async () => {
		const rootPath = await createTemporaryDirectory();
		const runtimeDir = path.join(rootPath, 'runtime');
		const zoneFilesDir = path.join(rootPath, 'zone-files', 'sunfam');
		const remoteUrl = path.join(rootPath, 'remote.git');
		await mkdir(zoneFilesDir, { recursive: true });
		await writeFile(path.join(zoneFilesDir, 'AGENTS.md'), 'initial\n');
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
		const localHead = await commitZoneFiles({
			gitDir,
			message: 'docs: seed zone files',
			workTree: zoneFilesDir,
		});

		await expect(
			pushZoneGit({
				branch: 'main',
				expectedHead: 'stale-head',
				remoteUrl,
				runtimeDir,
				zoneFilesDir,
				zoneId: 'sunfam',
			}),
		).rejects.toThrow(
			`Zone Git repository for zone 'sunfam' local HEAD '${localHead}' does not match expectedHead 'stale-head'.`,
		);
		await expect(
			execa('git', ['--git-dir', remoteUrl, 'rev-parse', '--verify', 'refs/heads/main']),
		).rejects.toThrow();
	});

	it('clears stale remote tracking refs when the configured remote branch is missing', async () => {
		const rootPath = await createTemporaryDirectory();
		const runtimeDir = path.join(rootPath, 'runtime');
		const zoneFilesDir = path.join(rootPath, 'zone-files', 'sunfam');
		const remoteUrl = path.join(rootPath, 'remote.git');
		await mkdir(zoneFilesDir, { recursive: true });
		await writeFile(path.join(zoneFilesDir, 'AGENTS.md'), 'initial\n');
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
		const localHead = await commitZoneFiles({
			gitDir,
			message: 'docs: seed zone files',
			workTree: zoneFilesDir,
		});
		await pushZoneGit({
			branch: 'main',
			expectedHead: localHead,
			remoteUrl,
			runtimeDir,
			zoneFilesDir,
			zoneId: 'sunfam',
		});
		await execa('git', ['--git-dir', remoteUrl, 'update-ref', '-d', 'refs/heads/main']);

		await expect(
			getZoneGitStatus({
				branch: 'main',
				remoteUrl,
				runtimeDir,
				zoneFilesDir,
				zoneId: 'sunfam',
			}),
		).resolves.toMatchObject({
			aheadOfRemote: 1,
			remoteHead: null,
		});
	});
});
