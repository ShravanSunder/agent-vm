import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { execa } from 'execa';

import type { RepoLocation } from '../shared/repo-location.js';

const GIT_BOOTSTRAP_TIMEOUT_MS = 120_000;

function buildTaskBranchName(branchPrefix: string, taskId: string): string {
	return `${branchPrefix}${taskId}`;
}

async function bootstrapRepoWorktree(options: {
	readonly branchPrefix: string;
	readonly repo: RepoLocation;
	readonly taskId: string;
}): Promise<void> {
	await mkdir(options.repo.workPath, { recursive: true });
	await mkdir(dirname(options.repo.gitDirPath), { recursive: true });
	await writeFile(join(options.repo.workPath, '.git'), `gitdir: ${options.repo.gitDirPath}\n`, {
		encoding: 'utf8',
		mode: 0o644,
	});
	await execa(
		'git',
		[
			'-c',
			'core.hooksPath=/dev/null',
			`--git-dir=${options.repo.gitDirPath}`,
			`--work-tree=${options.repo.workPath}`,
			'checkout',
			'-B',
			buildTaskBranchName(options.branchPrefix, options.taskId),
			options.repo.baseBranch,
		],
		{
			reject: true,
			timeout: GIT_BOOTSTRAP_TIMEOUT_MS,
		},
	);
}

export async function bootstrapRepoWorktrees(options: {
	readonly branchPrefix: string;
	readonly repos: readonly RepoLocation[];
	readonly taskId: string;
}): Promise<void> {
	await Promise.all(
		options.repos.map(async (repo) => {
			await bootstrapRepoWorktree({
				branchPrefix: options.branchPrefix,
				repo,
				taskId: options.taskId,
			});
		}),
	);
}
