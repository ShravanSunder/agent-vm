import type { TaskEvent } from '@agent-vm/agent-vm-worker';
import { execa } from 'execa';

import type { ActiveWorkerTask } from './active-task-registry.js';
import { scrubGithubTokenFromOutput } from './git-auth-support.js';
import { runGitCommandWithTransientRetries, type GitCommandResult } from './git-retry-support.js';

const GIT_OPERATION_TIMEOUT_MS = 120_000;
const GIT_PULL_RETRY_AFTER_SECONDS = 300;
const GIT_PULL_RETRY_AFTER_MESSAGE =
	'GitHub or the network is still rejecting the pull after retries. Try git-pull-default again in 5 minutes if the task is still running; otherwise start a new task.';

export interface PullDefaultRequest {
	readonly repoUrl: string;
	readonly currentBranch?: string | null | undefined;
	readonly currentHead?: string | undefined;
	readonly worktreeDirty?: boolean | undefined;
}

export interface PullDefaultCommitSummary {
	readonly sha: string;
	readonly subject: string;
	readonly author?: string;
	readonly date?: string;
}

interface MutablePullDefaultCommitSummary {
	sha: string;
	subject: string;
	author?: string;
	date?: string;
}

export interface PullDefaultResult {
	readonly repoUrl: string;
	readonly success: boolean;
	readonly error?: string;
	readonly defaultBranch?: string;
	readonly remoteDefaultHead?: string;
	readonly localDefaultHead?: string;
	readonly currentBranch?: string | null;
	readonly fetchedCommits?: readonly PullDefaultCommitSummary[];
	readonly commitsSinceForkPoint?: readonly PullDefaultCommitSummary[];
	readonly currentBranchSync?: PullCurrentBranchSyncResult;
	readonly divergence?: {
		readonly aheadOfDefault: number;
		readonly behindDefault: number;
		readonly forkPoint: string;
	};
}

export interface PullCurrentBranchSyncResult {
	readonly branch: string | null;
	readonly upstreamTrackingRef: string | null;
	readonly status:
		| 'ahead'
		| 'default-branch'
		| 'detached'
		| 'dirty-worktree'
		| 'diverged'
		| 'fast-forwarded'
		| 'no-upstream'
		| 'up-to-date';
	readonly reason?: string;
	readonly localHead?: string;
	readonly remoteHead?: string;
}

export class PullDefaultValidationError extends Error {}

class GitPullFailedAfterRetriesError extends Error {
	public constructor(
		message: string,
		public readonly attempts: number,
	) {
		super(message);
		this.name = 'GitPullFailedAfterRetriesError';
	}
}

function parseRepoFromUrl(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/, '');
	const urlPattern = /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)$/u;
	const match = urlPattern.exec(cleaned);
	if (match?.[1]) return match[1];
	if (/^[^\s/]+\/[^\s/]+$/u.test(cleaned)) return cleaned;
	throw new PullDefaultValidationError(`Invalid GitHub repository: ${repoUrl}`);
}

function buildAuthenticatedGitUrl(repoUrl: string, githubToken: string): string {
	return `https://x-access-token:${githubToken}@github.com/${parseRepoFromUrl(repoUrl)}.git`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function git(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly reject?: boolean;
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
	const result = await execa(
		'git',
		['-c', 'core.hooksPath=/dev/null', `--git-dir=${options.gitDir}`, ...options.args],
		{
			reject: false,
			timeout: GIT_OPERATION_TIMEOUT_MS,
		},
	);
	const normalized = {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode ?? 0,
	};
	if (options.reject === true && normalized.exitCode !== 0) {
		throw new Error(
			`git ${options.args.join(' ')} failed\n${normalized.stdout}\n${normalized.stderr}`.trim(),
		);
	}
	return normalized;
}

function formatGitCommandFailure(args: readonly string[], result: GitCommandResult): string {
	return `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`.trim();
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

async function gitWithTransientRetries(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
}): Promise<GitCommandResult> {
	const retryResult = await runGitCommandWithTransientRetries({
		run: async () => await git({ args: options.args, gitDir: options.gitDir, reject: false }),
		sleep,
	});
	if (retryResult.result.exitCode !== 0) {
		throw new Error(formatGitCommandFailure(options.args, retryResult.result));
	}
	return retryResult.result;
}

async function gitStdout(gitDir: string, args: readonly string[]): Promise<string> {
	return (await gitWithTransientRetries({ args, gitDir })).stdout.trim();
}

function parseCommitSummaries(output: string): readonly PullDefaultCommitSummary[] {
	if (output.trim().length === 0) return [];
	return output
		.trim()
		.split('\n')
		.map((line) => {
			const [sha = '', subject = '', author = '', date = ''] = line.split('\t');
			const summary: MutablePullDefaultCommitSummary = {
				sha,
				subject,
			};
			if (author) {
				summary.author = author;
			}
			if (date) {
				summary.date = date;
			}
			return summary;
		});
}

async function commitSummaries(
	gitDir: string,
	range: string,
): Promise<readonly PullDefaultCommitSummary[]> {
	const result = await gitWithTransientRetries({
		gitDir,
		args: ['log', range, '--format=%H%x09%s%x09%an%x09%aI'],
	});
	return parseCommitSummaries(result.stdout);
}

async function refExists(gitDir: string, ref: string): Promise<boolean> {
	const args = ['rev-parse', '--verify', '--quiet', ref] as const;
	const result = await git({ gitDir, args, reject: false });
	if (result.exitCode === 0) return true;
	if (result.stderr.trim().length > 0) {
		throw new Error(formatGitCommandFailure(args, result));
	}
	return false;
}

async function countRange(gitDir: string, range: string): Promise<number> {
	const result = await gitWithTransientRetries({
		gitDir,
		args: ['rev-list', '--count', range],
	});
	const parsed = Number.parseInt(result.stdout.trim(), 10);
	if (Number.isNaN(parsed)) {
		throw new Error(`git rev-list --count ${range} returned non-numeric output: ${result.stdout}`);
	}
	return parsed;
}

async function currentBranch(gitDir: string): Promise<string | null> {
	const branch = await gitStdout(gitDir, ['branch', '--show-current']);
	return branch.length > 0 ? branch : null;
}

async function fetchCurrentBranch(options: {
	readonly branch: string;
	readonly gitDir: string;
	readonly githubToken: string;
	readonly repoUrl: string;
}): Promise<'fetched' | 'no-upstream'> {
	const remoteRef = `refs/remotes/origin/${options.branch}`;
	const fetchArgs = [
		'fetch',
		'--prune',
		buildAuthenticatedGitUrl(options.repoUrl, options.githubToken),
		`refs/heads/${options.branch}:${remoteRef}`,
	] as const;
	const retryResult = await runGitCommandWithTransientRetries({
		run: async () => await git({ gitDir: options.gitDir, args: fetchArgs, reject: false }),
		sleep,
	});
	const result = retryResult.result;
	if (result.exitCode === 0) return 'fetched';
	const output = `${result.stdout}\n${result.stderr}`;
	if (
		/couldn't find remote ref|could not find remote ref|couldn't find remote branch|remote ref does not exist/iu.test(
			output,
		)
	) {
		return 'no-upstream';
	}
	throw new Error(formatGitCommandFailure(fetchArgs, result));
}

async function buildCurrentBranchSyncResult(options: {
	readonly defaultBranch: string;
	readonly gitDir: string;
	readonly githubToken: string;
	readonly pullRequest: PullDefaultRequest;
	readonly repoUrl: string;
}): Promise<PullCurrentBranchSyncResult> {
	const branch =
		options.pullRequest.currentBranch !== undefined
			? options.pullRequest.currentBranch
			: await currentBranch(options.gitDir);
	if (!branch) {
		const detachedHead =
			options.pullRequest.currentHead ?? (await gitStdout(options.gitDir, ['rev-parse', 'HEAD']));
		return {
			branch: null,
			upstreamTrackingRef: null,
			status: 'detached',
			localHead: detachedHead,
			reason: `Detached HEAD at ${detachedHead}; controller did not pull the current branch.`,
		};
	}
	const localRef = `refs/heads/${branch}`;
	const remoteRef = `refs/remotes/origin/${branch}`;
	const upstreamTrackingRef = `origin/${branch}`;
	if (branch === options.defaultBranch) {
		const remoteHead = await gitStdout(options.gitDir, [
			'rev-parse',
			`refs/remotes/origin/${branch}`,
		]);
		return {
			branch,
			upstreamTrackingRef,
			status: 'default-branch',
			remoteHead,
			reason: `Current branch '${branch}' is the default branch; git-pull-default already refreshed it.`,
		};
	}
	const fetchStatus = await fetchCurrentBranch({
		branch,
		gitDir: options.gitDir,
		githubToken: options.githubToken,
		repoUrl: options.repoUrl,
	});
	if (fetchStatus === 'no-upstream') {
		return {
			branch,
			upstreamTrackingRef: null,
			status: 'no-upstream',
			...(options.pullRequest.currentHead ? { localHead: options.pullRequest.currentHead } : {}),
			reason: `Current branch '${branch}' has no upstream tracking ref on origin.`,
		};
	}
	const localHead =
		options.pullRequest.currentHead ?? (await gitStdout(options.gitDir, ['rev-parse', localRef]));
	const remoteHead = await gitStdout(options.gitDir, ['rev-parse', remoteRef]);
	if (localHead === remoteHead) {
		return {
			branch,
			upstreamTrackingRef,
			status: 'up-to-date',
			localHead,
			remoteHead,
		};
	}
	const localAncestorOfRemote = await git({
		gitDir: options.gitDir,
		args: ['merge-base', '--is-ancestor', localRef, remoteRef],
		reject: false,
	});
	if (localAncestorOfRemote.exitCode === 0) {
		if (options.pullRequest.worktreeDirty === true) {
			return {
				branch,
				upstreamTrackingRef,
				status: 'dirty-worktree',
				localHead,
				remoteHead,
				reason: `Current branch '${branch}' can fast-forward to ${upstreamTrackingRef}, but the worker worktree has uncommitted changes.`,
			};
		}
		await gitWithTransientRetries({
			gitDir: options.gitDir,
			args: ['update-ref', localRef, remoteRef],
		});
		return {
			branch,
			upstreamTrackingRef,
			status: 'fast-forwarded',
			localHead,
			remoteHead,
		};
	}
	const remoteAncestorOfLocal = await git({
		gitDir: options.gitDir,
		args: ['merge-base', '--is-ancestor', remoteRef, localRef],
		reject: false,
	});
	if (remoteAncestorOfLocal.exitCode === 0) {
		return {
			branch,
			upstreamTrackingRef,
			status: 'ahead',
			localHead,
			remoteHead,
			reason: `Current branch '${branch}' is ahead of ${upstreamTrackingRef}; controller did not modify it.`,
		};
	}
	return {
		branch,
		upstreamTrackingRef,
		status: 'diverged',
		localHead,
		remoteHead,
		reason: `Current branch '${branch}' diverged from ${upstreamTrackingRef}; controller did not merge or rebase. Resolve manually or ask for a merge plan.`,
	};
}

export async function pullDefaultForTask(options: {
	readonly activeTask: ActiveWorkerTask;
	readonly currentBranch?: string | null;
	readonly currentHead?: string;
	readonly repoUrl: string;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
	readonly worktreeDirty?: boolean;
}): Promise<PullDefaultResult> {
	const repo = options.activeTask.repos.find((candidate) => candidate.repoUrl === options.repoUrl);
	if (!repo) {
		throw new PullDefaultValidationError(
			`Repo '${options.repoUrl}' is not registered for active task '${options.activeTask.taskId}'.`,
		);
	}

	try {
		const defaultBranch = repo.baseBranch;
		const defaultRef = `refs/heads/${defaultBranch}`;
		const remoteDefaultRef = `refs/remotes/origin/${defaultBranch}`;
		const previousRemoteDefaultHead = (await refExists(repo.hostGitDir, remoteDefaultRef))
			? await gitStdout(repo.hostGitDir, ['rev-parse', remoteDefaultRef])
			: null;
		await options.recordEvent?.({
			event: 'controller-git-pull-started',
			repoUrl: options.repoUrl,
		});
		const fetchArgs = [
			'fetch',
			'--prune',
			buildAuthenticatedGitUrl(options.repoUrl, options.githubToken),
			`${defaultBranch}:${remoteDefaultRef}`,
		] as const;
		const fetchRetryResult = await runGitCommandWithTransientRetries({
			run: async () => await git({ gitDir: repo.hostGitDir, args: fetchArgs, reject: false }),
			onRetry: async ({ attempt, delayMs, result }) => {
				const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
				await options.recordEvent?.({
					event: 'controller-git-pull-retry',
					repoUrl: options.repoUrl,
					attempts: attempt,
					message: detail,
					retryDelaySeconds: delayMs / 1000,
				});
			},
			sleep,
		});
		if (fetchRetryResult.result.exitCode !== 0) {
			const detail = scrubGithubTokenFromOutput(
				`${fetchRetryResult.result.stdout}\n${fetchRetryResult.result.stderr}`,
			).trim();
			const message =
				fetchRetryResult.attempts > 1
					? `Fetch failed\n${GIT_PULL_RETRY_AFTER_MESSAGE}\n${detail}`
					: `Fetch failed\n${detail}`;
			throw new GitPullFailedAfterRetriesError(message, fetchRetryResult.attempts);
		}

		const remoteDefaultHead = await gitStdout(repo.hostGitDir, ['rev-parse', remoteDefaultRef]);
		const fetchedCommits = previousRemoteDefaultHead
			? await commitSummaries(repo.hostGitDir, `${previousRemoteDefaultHead}..${remoteDefaultRef}`)
			: [];

		if (await refExists(repo.hostGitDir, defaultRef)) {
			const fastForwardCheck = await git({
				gitDir: repo.hostGitDir,
				args: ['merge-base', '--is-ancestor', defaultRef, remoteDefaultRef],
				reject: false,
			});
			if (fastForwardCheck.exitCode !== 0) {
				return {
					repoUrl: options.repoUrl,
					success: false,
					defaultBranch,
					remoteDefaultHead,
					error: `Local ${defaultBranch} cannot be fast-forwarded to origin/${defaultBranch}; inspect it manually.`,
				};
			}
		}

		await gitWithTransientRetries({
			gitDir: repo.hostGitDir,
			args: ['update-ref', defaultRef, remoteDefaultRef],
		});
		const localDefaultHead = await gitStdout(repo.hostGitDir, ['rev-parse', defaultRef]);
		const branch = await currentBranch(repo.hostGitDir);
		const shouldSyncCurrentBranch =
			options.currentBranch !== undefined ||
			options.currentHead !== undefined ||
			options.worktreeDirty !== undefined;
		const currentBranchSync = shouldSyncCurrentBranch
			? await buildCurrentBranchSyncResult({
					defaultBranch,
					gitDir: repo.hostGitDir,
					githubToken: options.githubToken,
					pullRequest: options,
					repoUrl: options.repoUrl,
				})
			: undefined;
		const forkPoint = await gitStdout(repo.hostGitDir, ['merge-base', 'HEAD', remoteDefaultRef]);
		const commitsSinceForkPoint = await commitSummaries(
			repo.hostGitDir,
			`${forkPoint}..${remoteDefaultRef}`,
		);

		const result = {
			repoUrl: options.repoUrl,
			success: true,
			defaultBranch,
			remoteDefaultHead,
			localDefaultHead,
			currentBranch: branch,
			...(currentBranchSync ? { currentBranchSync } : {}),
			fetchedCommits,
			commitsSinceForkPoint,
			divergence: {
				aheadOfDefault: await countRange(repo.hostGitDir, `${remoteDefaultRef}..HEAD`),
				behindDefault: await countRange(repo.hostGitDir, `HEAD..${remoteDefaultRef}`),
				forkPoint,
			},
		};
		await options.recordEvent?.({
			event: 'controller-git-pull-succeeded',
			repoUrl: options.repoUrl,
			attempts: fetchRetryResult.attempts,
			defaultBranch,
			remoteDefaultHead,
			localDefaultHead,
		});
		return result;
	} catch (error) {
		const retryAfterSeconds =
			error instanceof GitPullFailedAfterRetriesError && error.attempts > 1
				? GIT_PULL_RETRY_AFTER_SECONDS
				: undefined;
		await options.recordEvent?.({
			event: 'controller-git-pull-failed',
			repoUrl: options.repoUrl,
			attempts: error instanceof GitPullFailedAfterRetriesError ? error.attempts : 0,
			message: errorMessage(error),
			...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
		});
		return {
			repoUrl: options.repoUrl,
			success: false,
			error: errorMessage(error),
		};
	}
}
