import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	materializeWorkspaceGitRepository,
	pushWorkspaceGit,
	resolveWorkspaceGitBranchObjectId,
	WorkspaceGitConflictError,
	WorkspaceGitDefaultBranchError,
	type MaterializedWorkspaceGitRepository,
} from './workspace-git-operations.js';

interface RemoteWorkspaceFixture {
	readonly branch: string;
	readonly hostWorkspaceDirectory: string;
	readonly materialized: MaterializedWorkspaceGitRepository;
	readonly remoteGitDirectory: string;
	readonly runtimeDir: string;
}

async function createRemoteWorkspaceFixture(options: {
	readonly branch: string;
	readonly testRoot: string;
}): Promise<RemoteWorkspaceFixture> {
	const hostWorkspaceDirectory = path.join(options.testRoot, 'zone-files', 'agents', 'alice');
	const remoteGitDirectory = path.join(options.testRoot, 'remote.git');
	await Promise.all([
		mkdir(hostWorkspaceDirectory, { recursive: true }),
		execa('/usr/bin/git', ['init', '--bare', remoteGitDirectory]),
	]);
	const runtimeDir = path.join(options.testRoot, 'runtime');
	const materialized = await materializeWorkspaceGitRepository({
		agentId: 'alice',
		hostWorkspaceDirectory,
		policy: {
			branch: options.branch,
			kind: 'remote',
			remoteUrl: remoteGitDirectory,
		},
		runtimeDir,
		zoneId: 'gateway',
	});
	return {
		branch: options.branch,
		hostWorkspaceDirectory,
		materialized,
		remoteGitDirectory,
		runtimeDir,
	};
}

function sourceGitArguments(fixture: RemoteWorkspaceFixture): readonly string[] {
	return [
		`--git-dir=${fixture.materialized.hostGitDirectory}`,
		`--work-tree=${fixture.hostWorkspaceDirectory}`,
	];
}

async function commitWorkspaceFile(options: {
	readonly content: string;
	readonly fileName: string;
	readonly fixture: RemoteWorkspaceFixture;
	readonly message: string;
}): Promise<string> {
	await writeFile(
		path.join(options.fixture.hostWorkspaceDirectory, options.fileName),
		options.content,
		'utf8',
	);
	await execa('/usr/bin/git', [...sourceGitArguments(options.fixture), 'add', options.fileName]);
	await execa('/usr/bin/git', [
		...sourceGitArguments(options.fixture),
		'-c',
		'user.name=Agent VM E2E',
		'-c',
		'user.email=agent-vm-e2e@example.invalid',
		'commit',
		'-m',
		options.message,
	]);
	return (
		await execa('/usr/bin/git', [
			...sourceGitArguments(options.fixture),
			'rev-parse',
			`refs/heads/${options.fixture.branch}`,
		])
	).stdout.trim();
}

async function digestPathTree(rootPath: string): Promise<string> {
	const digest = createHash('sha256');
	async function addPath(relativePath: string): Promise<void> {
		const absolutePath = relativePath.length === 0 ? rootPath : path.join(rootPath, relativePath);
		const status = await lstat(absolutePath);
		digest.update(`${relativePath}\0${status.mode}\0${status.size}\0`);
		if (status.isDirectory()) {
			const childNames = (await readdir(absolutePath)).toSorted();
			for (const childName of childNames) {
				// oxlint-disable-next-line no-await-in-loop -- stable lexical hashing is intentionally sequential.
				await addPath(relativePath.length === 0 ? childName : path.join(relativePath, childName));
			}
			return;
		}
		digest.update(await readFile(absolutePath));
	}
	await addPath('');
	return digest.digest('hex');
}

async function snapshotAgentWritableGitSource(
	fixture: RemoteWorkspaceFixture,
): Promise<Readonly<{ gitDirectory: string; worktreePointer: string }>> {
	return {
		gitDirectory: await digestPathTree(fixture.materialized.hostGitDirectory),
		worktreePointer: await digestPathTree(path.join(fixture.hostWorkspaceDirectory, '.git')),
	};
}

async function pushFixtureHead(
	fixture: RemoteWorkspaceFixture,
	expectedHead: string,
	beforePushCompareAndSwap?: () => Promise<void>,
): ReturnType<typeof pushWorkspaceGit> {
	return await pushWorkspaceGit(
		{
			agentId: 'alice',
			branch: fixture.branch,
			expectedHead,
			hostWorkspaceDirectory: fixture.hostWorkspaceDirectory,
			remoteUrl: fixture.remoteGitDirectory,
			runtimeDir: fixture.runtimeDir,
			zoneId: 'gateway',
		},
		beforePushCompareAndSwap === undefined ? {} : { beforePushCompareAndSwap },
	);
}

async function readBareRemoteHead(
	fixture: RemoteWorkspaceFixture,
	branch: string = fixture.branch,
): Promise<string> {
	return (
		await execa('/usr/bin/git', [
			`--git-dir=${fixture.remoteGitDirectory}`,
			'rev-parse',
			`refs/heads/${branch}`,
		])
	).stdout.trim();
}

async function advanceRemoteFromIndependentClone(options: {
	readonly fixture: RemoteWorkspaceFixture;
	readonly message: string;
}): Promise<string> {
	const writerDirectory = path.join(
		path.dirname(options.fixture.remoteGitDirectory),
		'remote-writer',
	);
	await execa('/usr/bin/git', ['clone', options.fixture.remoteGitDirectory, writerDirectory]);
	await execa('/usr/bin/git', [
		'-C',
		writerDirectory,
		'checkout',
		'-b',
		options.fixture.branch,
		`origin/${options.fixture.branch}`,
	]);
	await writeFile(path.join(writerDirectory, 'REMOTE.md'), 'independent remote change\n', 'utf8');
	await execa('/usr/bin/git', ['-C', writerDirectory, 'add', 'REMOTE.md']);
	await execa('/usr/bin/git', [
		'-C',
		writerDirectory,
		'-c',
		'user.name=Independent Writer',
		'-c',
		'user.email=independent-writer@example.invalid',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-m',
		options.message,
	]);
	const remoteHead = (
		await execa('/usr/bin/git', ['-C', writerDirectory, 'rev-parse', 'HEAD'])
	).stdout.trim();
	await execa('/usr/bin/git', [
		'-C',
		writerDirectory,
		'push',
		'origin',
		`${remoteHead}:refs/heads/${options.fixture.branch}`,
	]);
	return remoteHead;
}

async function advanceRemoteAfterObservedHead(options: {
	readonly fixture: RemoteWorkspaceFixture;
	readonly nextRemoteHead: string;
	readonly observedRemoteHead: string;
}): Promise<void> {
	await execa('/usr/bin/git', [
		`--git-dir=${options.fixture.remoteGitDirectory}`,
		'update-ref',
		`refs/heads/${options.fixture.branch}`,
		options.nextRemoteHead,
		options.observedRemoteHead,
	]);
}

describe('workspace Git repository materialization', () => {
	let testRoot: string;

	beforeEach(async () => {
		testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-workspace-git-'));
		await mkdir(path.join(testRoot, 'runtime', 'zones', 'gateway'), { recursive: true });
	});

	afterEach(async () => {
		await rm(testRoot, { force: true, recursive: true });
	});

	it('creates one local workspace database and the Tool VM pointer', async () => {
		const hostWorkspaceDirectory = path.join(testRoot, 'zone-files', 'agents', 'alice');
		const hostileTemplateDirectory = path.join(testRoot, 'hostile-git-template');
		await mkdir(hostWorkspaceDirectory, { recursive: true });
		await mkdir(path.join(hostileTemplateDirectory, 'hooks'), { recursive: true });
		await writeFile(
			path.join(hostileTemplateDirectory, 'hooks', 'agent-controlled-hook'),
			'agent controlled\n',
			'utf8',
		);
		process.env.GIT_TEMPLATE_DIR = hostileTemplateDirectory;

		const materialized = await (async () => {
			try {
				return await materializeWorkspaceGitRepository({
					agentId: 'alice',
					hostWorkspaceDirectory,
					policy: { kind: 'local' },
					runtimeDir: path.join(testRoot, 'runtime'),
					zoneId: 'gateway',
				});
			} finally {
				delete process.env.GIT_TEMPLATE_DIR;
			}
		})();

		expect(materialized).toMatchObject({
			branch: 'agent/workspace',
			mode: 'local',
		});
		await expect(readFile(path.join(hostWorkspaceDirectory, '.git'), 'utf8')).resolves.toBe(
			'gitdir: /gitdirs/workspace.git\n',
		);
		await expect(
			readFile(path.join(materialized.hostGitDirectory, 'config'), 'utf8'),
		).resolves.not.toContain('[remote "origin"]');
		await expect(
			lstat(path.join(materialized.hostGitDirectory, 'hooks', 'agent-controlled-hook')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('records only the configured remote workspace branch for guest Git use', async () => {
		const hostWorkspaceDirectory = path.join(testRoot, 'zone-files', 'agents', 'alice');
		await mkdir(hostWorkspaceDirectory, { recursive: true });

		const materialized = await materializeWorkspaceGitRepository({
			agentId: 'alice',
			hostWorkspaceDirectory,
			policy: {
				branch: 'agent/alice-workspace',
				kind: 'remote',
				remoteUrl: 'https://github.com/example/alice-workspace.git',
			},
			runtimeDir: path.join(testRoot, 'runtime'),
			zoneId: 'gateway',
		});

		const gitConfig = await readFile(path.join(materialized.hostGitDirectory, 'config'), 'utf8');
		expect(gitConfig).toContain('[remote "origin"]');
		expect(gitConfig).toContain('url = https://github.com/example/alice-workspace.git');
		expect(gitConfig).toContain('[branch "agent/alice-workspace"]');
	});

	it('points a framework-initialized unborn repository at the configured workspace branch', async () => {
		const hostWorkspaceDirectory = path.join(testRoot, 'zone-files', 'agents', 'alice');
		await mkdir(hostWorkspaceDirectory, { recursive: true });
		await execa('/usr/bin/git', ['init', '--initial-branch=master', hostWorkspaceDirectory]);
		await writeFile(
			path.join(hostWorkspaceDirectory, 'BOOTSTRAP.md'),
			'framework bootstrap\n',
			'utf8',
		);

		const materialized = await materializeWorkspaceGitRepository({
			agentId: 'alice',
			hostWorkspaceDirectory,
			policy: {
				branch: 'agent/alice-workspace',
				kind: 'remote',
				remoteUrl: 'https://github.com/example/alice-workspace.git',
			},
			runtimeDir: path.join(testRoot, 'runtime'),
			zoneId: 'gateway',
		});

		await expect(
			execa('/usr/bin/git', [
				`--git-dir=${materialized.hostGitDirectory}`,
				`--work-tree=${hostWorkspaceDirectory}`,
				'symbolic-ref',
				'HEAD',
			]),
		).resolves.toMatchObject({ stdout: 'refs/heads/agent/alice-workspace' });
		await expect(readFile(path.join(hostWorkspaceDirectory, 'BOOTSTRAP.md'), 'utf8')).resolves.toBe(
			'framework bootstrap\n',
		);
	});

	it('does not repoint a framework repository that already has a commit', async () => {
		const hostWorkspaceDirectory = path.join(testRoot, 'zone-files', 'agents', 'alice');
		await mkdir(hostWorkspaceDirectory, { recursive: true });
		await execa('/usr/bin/git', ['init', '--initial-branch=master', hostWorkspaceDirectory]);
		await writeFile(
			path.join(hostWorkspaceDirectory, 'BOOTSTRAP.md'),
			'committed bootstrap\n',
			'utf8',
		);
		await execa('/usr/bin/git', ['-C', hostWorkspaceDirectory, 'add', 'BOOTSTRAP.md']);
		await execa('/usr/bin/git', [
			'-C',
			hostWorkspaceDirectory,
			'-c',
			'user.name=Framework',
			'-c',
			'user.email=framework@example.invalid',
			'commit',
			'-m',
			'framework bootstrap',
		]);
		const originalHead = (
			await execa('/usr/bin/git', ['-C', hostWorkspaceDirectory, 'rev-parse', 'HEAD'])
		).stdout;

		const materialized = await materializeWorkspaceGitRepository({
			agentId: 'alice',
			hostWorkspaceDirectory,
			policy: {
				branch: 'agent/alice-workspace',
				kind: 'remote',
				remoteUrl: 'https://github.com/example/alice-workspace.git',
			},
			runtimeDir: path.join(testRoot, 'runtime'),
			zoneId: 'gateway',
		});

		const hostGitArguments = [
			`--git-dir=${materialized.hostGitDirectory}`,
			`--work-tree=${hostWorkspaceDirectory}`,
		];
		await expect(
			execa('/usr/bin/git', [...hostGitArguments, 'symbolic-ref', 'HEAD']),
		).resolves.toMatchObject({ stdout: 'refs/heads/master' });
		await expect(
			execa('/usr/bin/git', [...hostGitArguments, 'rev-parse', 'HEAD']),
		).resolves.toMatchObject({ stdout: originalHead });
	});

	it('does not repoint an unborn HEAD when another committed ref exists', async () => {
		const hostWorkspaceDirectory = path.join(testRoot, 'zone-files', 'agents', 'alice');
		await mkdir(hostWorkspaceDirectory, { recursive: true });
		await execa('/usr/bin/git', ['init', '--initial-branch=master', hostWorkspaceDirectory]);
		await writeFile(
			path.join(hostWorkspaceDirectory, 'BOOTSTRAP.md'),
			'committed bootstrap\n',
			'utf8',
		);
		await execa('/usr/bin/git', ['-C', hostWorkspaceDirectory, 'add', 'BOOTSTRAP.md']);
		await execa('/usr/bin/git', [
			'-C',
			hostWorkspaceDirectory,
			'-c',
			'user.name=Framework',
			'-c',
			'user.email=framework@example.invalid',
			'commit',
			'-m',
			'framework bootstrap',
		]);
		const committedHead = (
			await execa('/usr/bin/git', ['-C', hostWorkspaceDirectory, 'rev-parse', 'HEAD'])
		).stdout;
		await execa('/usr/bin/git', [
			'-C',
			hostWorkspaceDirectory,
			'checkout',
			'--orphan',
			'framework-unborn',
		]);

		const materialized = await materializeWorkspaceGitRepository({
			agentId: 'alice',
			hostWorkspaceDirectory,
			policy: {
				branch: 'agent/alice-workspace',
				kind: 'remote',
				remoteUrl: 'https://github.com/example/alice-workspace.git',
			},
			runtimeDir: path.join(testRoot, 'runtime'),
			zoneId: 'gateway',
		});

		const hostGitArguments = [
			`--git-dir=${materialized.hostGitDirectory}`,
			`--work-tree=${hostWorkspaceDirectory}`,
		];
		await expect(
			execa('/usr/bin/git', [...hostGitArguments, 'symbolic-ref', 'HEAD']),
		).resolves.toMatchObject({ stdout: 'refs/heads/framework-unborn' });
		await expect(
			execa('/usr/bin/git', [...hostGitArguments, 'rev-parse', 'refs/heads/master']),
		).resolves.toMatchObject({ stdout: committedHead });
	});

	it('does not repoint a detached committed HEAD', async () => {
		const hostWorkspaceDirectory = path.join(testRoot, 'zone-files', 'agents', 'alice');
		await mkdir(hostWorkspaceDirectory, { recursive: true });
		await execa('/usr/bin/git', ['init', '--initial-branch=master', hostWorkspaceDirectory]);
		await writeFile(
			path.join(hostWorkspaceDirectory, 'BOOTSTRAP.md'),
			'committed bootstrap\n',
			'utf8',
		);
		await execa('/usr/bin/git', ['-C', hostWorkspaceDirectory, 'add', 'BOOTSTRAP.md']);
		await execa('/usr/bin/git', [
			'-C',
			hostWorkspaceDirectory,
			'-c',
			'user.name=Framework',
			'-c',
			'user.email=framework@example.invalid',
			'commit',
			'-m',
			'framework bootstrap',
		]);
		const committedHead = (
			await execa('/usr/bin/git', ['-C', hostWorkspaceDirectory, 'rev-parse', 'HEAD'])
		).stdout;
		await execa('/usr/bin/git', ['-C', hostWorkspaceDirectory, 'checkout', '--detach']);

		const materialized = await materializeWorkspaceGitRepository({
			agentId: 'alice',
			hostWorkspaceDirectory,
			policy: {
				branch: 'agent/alice-workspace',
				kind: 'remote',
				remoteUrl: 'https://github.com/example/alice-workspace.git',
			},
			runtimeDir: path.join(testRoot, 'runtime'),
			zoneId: 'gateway',
		});

		const hostGitArguments = [
			`--git-dir=${materialized.hostGitDirectory}`,
			`--work-tree=${hostWorkspaceDirectory}`,
		];
		await expect(
			execa('/usr/bin/git', [...hostGitArguments, 'symbolic-ref', '--quiet', 'HEAD']),
		).rejects.toMatchObject({ exitCode: 1 });
		await expect(
			execa('/usr/bin/git', [...hostGitArguments, 'rev-parse', 'HEAD']),
		).resolves.toMatchObject({ stdout: committedHead });
	});

	it('pushes one exact committed head through a sanitized local-remote view', async () => {
		const hostWorkspaceDirectory = path.join(testRoot, 'zone-files', 'agents', 'alice');
		const remoteGitDirectory = path.join(testRoot, 'remote.git');
		await Promise.all([
			mkdir(hostWorkspaceDirectory, { recursive: true }),
			execa('/usr/bin/git', ['init', '--bare', remoteGitDirectory]),
		]);
		const materialized = await materializeWorkspaceGitRepository({
			agentId: 'alice',
			hostWorkspaceDirectory,
			policy: {
				branch: 'agent/alice-workspace',
				kind: 'remote',
				remoteUrl: remoteGitDirectory,
			},
			runtimeDir: path.join(testRoot, 'runtime'),
			zoneId: 'gateway',
		});
		await writeFile(path.join(hostWorkspaceDirectory, 'MEMORY.md'), 'durable memory\n', 'utf8');
		const hostGitArguments = [
			`--git-dir=${materialized.hostGitDirectory}`,
			`--work-tree=${hostWorkspaceDirectory}`,
		];
		await execa('/usr/bin/git', [...hostGitArguments, 'add', 'MEMORY.md']);
		await execa('/usr/bin/git', [
			...hostGitArguments,
			'-c',
			'user.name=Agent VM E2E',
			'-c',
			'user.email=agent-vm-e2e@example.invalid',
			'commit',
			'-m',
			'test: save agent memory',
		]);
		const localHead = (
			await execa('/usr/bin/git', [...hostGitArguments, 'rev-parse', 'HEAD'])
		).stdout.trim();
		await writeFile(
			path.join(materialized.hostGitDirectory, 'config'),
			`${await readFile(path.join(materialized.hostGitDirectory, 'config'), 'utf8')}\n[alias]\n\tpwn = !touch '${path.join(testRoot, 'escaped')}'\n`,
			'utf8',
		);

		const result = await pushWorkspaceGit({
			agentId: 'alice',
			branch: 'agent/alice-workspace',
			expectedHead: localHead,
			hostWorkspaceDirectory,
			remoteUrl: remoteGitDirectory,
			runtimeDir: path.join(testRoot, 'runtime'),
			zoneId: 'gateway',
		});

		expect(result).toMatchObject({
			branch: 'agent/alice-workspace',
			localHead,
			remoteHead: localHead,
		});
		expect(result.pushedCommits).toEqual([
			expect.objectContaining({ sha: localHead, subject: 'test: save agent memory' }),
		]);
		await expect(
			execa('/usr/bin/git', [
				`--git-dir=${remoteGitDirectory}`,
				'rev-parse',
				'refs/heads/agent/alice-workspace',
			]),
		).resolves.toMatchObject({ stdout: localHead });
		await expect(lstat(path.join(testRoot, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('pushes a packed configured-branch head without mutating the agent-writable Git source', async () => {
		const fixture = await createRemoteWorkspaceFixture({
			branch: 'agent/packed-workspace',
			testRoot,
		});
		const baseHead = await commitWorkspaceFile({
			content: 'base memory\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: seed packed workspace',
		});
		await pushFixtureHead(fixture, baseHead);
		const localHead = await commitWorkspaceFile({
			content: 'base memory\nnew memory\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: advance packed workspace',
		});
		await execa('/usr/bin/git', [...sourceGitArguments(fixture), 'pack-refs', '--all']);
		await expect(
			lstat(
				path.join(
					fixture.materialized.hostGitDirectory,
					'refs',
					'heads',
					...fixture.branch.split('/'),
				),
			),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			resolveWorkspaceGitBranchObjectId({
				agentId: 'alice',
				branch: fixture.branch,
				runtimeDir: fixture.runtimeDir,
				zoneId: 'gateway',
			}),
		).resolves.toBe(localHead);
		const sourceBeforePush = await snapshotAgentWritableGitSource(fixture);

		const result = await pushFixtureHead(fixture, localHead);

		expect(result).toMatchObject({ localHead, remoteHead: localHead });
		expect(result.pushedCommits).toEqual([
			expect.objectContaining({ sha: localHead, subject: 'test: advance packed workspace' }),
		]);
		await expect(readBareRemoteHead(fixture)).resolves.toBe(localHead);
		await expect(snapshotAgentWritableGitSource(fixture)).resolves.toEqual(sourceBeforePush);
	});

	it('uses one exact lowercase object-id contract for expectedHead and configured refs', async () => {
		const fixture = await createRemoteWorkspaceFixture({
			branch: 'agent/object-id-validation',
			testRoot,
		});
		await commitWorkspaceFile({
			content: 'memory\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: validate object ids',
		});

		await expect(pushFixtureHead(fixture, 'A'.repeat(40))).rejects.toThrow(
			WorkspaceGitConflictError,
		);
		await writeFile(
			path.join(
				fixture.materialized.hostGitDirectory,
				'refs',
				'heads',
				...fixture.branch.split('/'),
			),
			`${'A'.repeat(40)}\n`,
			'utf8',
		);
		await expect(
			resolveWorkspaceGitBranchObjectId({
				agentId: 'alice',
				branch: fixture.branch,
				runtimeDir: fixture.runtimeDir,
				zoneId: 'gateway',
			}),
		).rejects.toThrow(/loose object id.*exact lowercase/u);
	});

	it('rejects stale expectedHead and the configured default branch before remote access', async () => {
		const fixture = await createRemoteWorkspaceFixture({
			branch: 'agent/preflight',
			testRoot,
		});
		const localHead = await commitWorkspaceFile({
			content: 'memory\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: preflight authority',
		});
		const unreachableRemote = path.join(testRoot, 'must-not-be-contacted.git');
		const baseOptions = {
			agentId: 'alice',
			expectedHead: localHead,
			hostWorkspaceDirectory: fixture.hostWorkspaceDirectory,
			remoteUrl: unreachableRemote,
			runtimeDir: fixture.runtimeDir,
			zoneId: 'gateway',
		} as const;

		await expect(
			pushWorkspaceGit({
				...baseOptions,
				branch: fixture.branch,
				expectedHead: '0'.repeat(40),
			}),
		).rejects.toThrow(WorkspaceGitConflictError);
		await expect(
			pushWorkspaceGit({
				...baseOptions,
				branch: 'agent/default',
				defaultBranch: 'agent/default',
			}),
		).rejects.toThrow(WorkspaceGitDefaultBranchError);
	});

	it('refuses a non-fast-forward remote head without replaying or mutating local state', async () => {
		const fixture = await createRemoteWorkspaceFixture({
			branch: 'agent/non-fast-forward',
			testRoot,
		});
		const baseHead = await commitWorkspaceFile({
			content: 'base\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: seed shared base',
		});
		await pushFixtureHead(fixture, baseHead);
		const localHead = await commitWorkspaceFile({
			content: 'local divergence\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: local divergence',
		});
		const remoteHead = await advanceRemoteFromIndependentClone({
			fixture,
			message: 'test: remote divergence',
		});
		const sourceBeforePush = await snapshotAgentWritableGitSource(fixture);

		await expect(pushFixtureHead(fixture, localHead)).rejects.toThrow(WorkspaceGitConflictError);

		await expect(readBareRemoteHead(fixture)).resolves.toBe(remoteHead);
		await expect(snapshotAgentWritableGitSource(fixture)).resolves.toEqual(sourceBeforePush);
		await expect(
			resolveWorkspaceGitBranchObjectId({
				agentId: 'alice',
				branch: fixture.branch,
				runtimeDir: fixture.runtimeDir,
				zoneId: 'gateway',
			}),
		).resolves.toBe(localHead);
	});

	it('refuses an observed-head race through the exact remote compare-and-swap lease', async () => {
		const fixture = await createRemoteWorkspaceFixture({
			branch: 'agent/cas-race',
			testRoot,
		});
		const observedRemoteHead = await commitWorkspaceFile({
			content: 'base\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: seed race base',
		});
		await pushFixtureHead(fixture, observedRemoteHead);
		const racedRemoteHead = await commitWorkspaceFile({
			content: 'base\nraced\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: race advance',
		});
		await execa('/usr/bin/git', [
			...sourceGitArguments(fixture),
			'push',
			fixture.remoteGitDirectory,
			`${racedRemoteHead}:refs/heads/race-target`,
		]);
		const localHead = await commitWorkspaceFile({
			content: 'base\nraced\nlocal\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: local after race target',
		});
		const sourceBeforePush = await snapshotAgentWritableGitSource(fixture);
		await expect(
			pushFixtureHead(
				fixture,
				localHead,
				async () =>
					await advanceRemoteAfterObservedHead({
						fixture,
						nextRemoteHead: racedRemoteHead,
						observedRemoteHead,
					}),
			),
		).rejects.toThrow();

		await expect(readBareRemoteHead(fixture)).resolves.toBe(racedRemoteHead);
		await expect(snapshotAgentWritableGitSource(fixture)).resolves.toEqual(sourceBeforePush);
	});

	it('refuses an absent-head race through the explicit empty compare-and-swap lease', async () => {
		const fixture = await createRemoteWorkspaceFixture({
			branch: 'agent/absent-cas-race',
			testRoot,
		});
		const competingRemoteHead = await commitWorkspaceFile({
			content: 'competing head\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: prepare absent-ref competitor',
		});
		await execa('/usr/bin/git', [
			...sourceGitArguments(fixture),
			'push',
			fixture.remoteGitDirectory,
			`${competingRemoteHead}:refs/heads/race-target`,
		]);
		const localHead = await commitWorkspaceFile({
			content: 'competing head\nlocal head\n',
			fileName: 'MEMORY.md',
			fixture,
			message: 'test: local after absent-ref competitor',
		});
		await expect(readBareRemoteHead(fixture)).rejects.toThrow();
		const sourceBeforePush = await snapshotAgentWritableGitSource(fixture);

		await expect(
			pushWorkspaceGit(
				{
					agentId: 'alice',
					branch: fixture.branch,
					expectedHead: localHead,
					hostWorkspaceDirectory: fixture.hostWorkspaceDirectory,
					remoteUrl: fixture.remoteGitDirectory,
					runtimeDir: fixture.runtimeDir,
					zoneId: 'gateway',
				},
				{
					beforePushCompareAndSwap: async (observation) => {
						expect(observation).toEqual({
							branch: fixture.branch,
							localHead,
							remoteHead: null,
						});
						await advanceRemoteAfterObservedHead({
							fixture,
							nextRemoteHead: competingRemoteHead,
							observedRemoteHead: '0'.repeat(40),
						});
					},
				},
			),
		).rejects.toThrow();

		await expect(readBareRemoteHead(fixture)).resolves.toBe(competingRemoteHead);
		await expect(snapshotAgentWritableGitSource(fixture)).resolves.toEqual(sourceBeforePush);
	});
});
