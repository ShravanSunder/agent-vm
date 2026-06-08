import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHostGitDir } from './active-task-registry.js';
import { buildHostGitArgs } from './host-git-command.js';

let tempDir: string;

async function git(args: readonly string[], cwd?: string): Promise<string> {
	const result = await execa('git', [...args], cwd ? { cwd } : {});
	return result.stdout.trim();
}

describe('buildHostGitArgs', () => {
	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-host-git-'));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { force: true, recursive: true });
	});

	it('pins a host-visible worktree when a shared gitdir stores a VM-only core.worktree', async () => {
		const sourceRepoPath = path.join(tempDir, 'source');
		const hostRuntimePath = path.join(tempDir, 'runtime');
		const gitDirPath = path.join(hostRuntimePath, 'gitdirs', 'widgets.git');
		await fs.mkdir(sourceRepoPath, { recursive: true });
		await fs.mkdir(path.dirname(gitDirPath), { recursive: true });

		await git(['init', '--initial-branch=main'], sourceRepoPath);
		await git(['config', 'user.email', 'agent-vm@example.com'], sourceRepoPath);
		await git(['config', 'user.name', 'Agent VM'], sourceRepoPath);
		await git(['config', 'commit.gpgsign', 'false'], sourceRepoPath);
		await fs.writeFile(path.join(sourceRepoPath, 'README.md'), 'hello\n', 'utf8');
		await git(['add', 'README.md'], sourceRepoPath);
		await git(['commit', '-m', 'initial commit'], sourceRepoPath);
		const expectedHead = await git(['rev-parse', 'HEAD'], sourceRepoPath);
		const hostGitDir = createHostGitDir(gitDirPath);

		await git(['clone', '--bare', sourceRepoPath, gitDirPath]);
		await git(['--git-dir', gitDirPath, 'config', 'core.bare', 'false']);
		await git(['--git-dir', gitDirPath, 'config', 'core.worktree', '/work/repos/widgets']);

		await expect(
			execa('git', ['--git-dir', gitDirPath, 'rev-parse', 'HEAD']),
		).rejects.toMatchObject({
			stderr: expect.stringContaining('/work'),
		});

		const actualHead = await git(
			buildHostGitArgs({ gitDir: hostGitDir, args: ['rev-parse', 'HEAD'] }),
		);

		expect(actualHead).toBe(expectedHead);
	});
});
