import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { execa } from 'execa';

import type { RepoLocation } from '../shared/repo-location.js';

const GIT_BOOTSTRAP_TIMEOUT_MS = 120_000;

function buildTaskBranchName(branchPrefix: string, taskId: string): string {
	return `${branchPrefix}${taskId}`;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
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

async function replaceSymlink(linkPath: string, target: string): Promise<void> {
	await rm(linkPath, { force: true });
	await symlink(target, linkPath);
}

export async function bootstrapRepoWorktrees(options: {
	readonly branchPrefix: string;
	readonly repoRootPath: string;
	readonly repos: readonly RepoLocation[];
	readonly taskId: string;
}): Promise<void> {
	await mkdir(options.repoRootPath, { recursive: true });
	await replaceSymlink(join(options.repoRootPath, 'AGENTS.md'), '/agent-vm/agents.md');
	await replaceSymlink(join(options.repoRootPath, 'CLAUDE.md'), 'AGENTS.md');
	const bootstrapResults = await Promise.allSettled(
		options.repos.map(async (repo) => {
			await bootstrapRepoWorktree({
				branchPrefix: options.branchPrefix,
				repo,
				taskId: options.taskId,
			});
		}),
	);
	const failedBootstraps = bootstrapResults.filter(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	);
	if (failedBootstraps.length > 0) {
		const failureErrors = failedBootstraps.map((result) => toError(result.reason));
		const failureDetails = failedBootstraps
			.map((result) =>
				result.reason instanceof Error ? result.reason.message : String(result.reason),
			)
			.join('\n');
		throw new AggregateError(
			failureErrors,
			`Failed to bootstrap ${failedBootstraps.length} repo worktree(s).\n${failureDetails}`,
		);
	}
}
