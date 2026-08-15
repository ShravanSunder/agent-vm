import type { TaskEvent } from '@agent-vm/agent-vm-worker';
import { execa } from 'execa';

import type { ActiveWorkerTask, HostGitDir } from './active-task-registry.js';
import { writeControllerDiagnostic } from './controller-diagnostic-logging.js';
import { scrubGithubTokenFromOutput } from './git-auth-support.js';
import { runGitCommandWithTransientRetries, type GitCommandResult } from './git-retry-support.js';
import { buildHostGitArgs } from './host-git-command.js';

const GIT_OPERATION_TIMEOUT_MS = 120_000;
const GIT_PULL_RETRY_AFTER_SECONDS = 300;
const GIT_PULL_RETRY_AFTER_MESSAGE =
	'GitHub or the network is still rejecting the pull after retries. Try git-pull-default again in 5 minutes; the controller retains task state while the task remains registered.';

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

interface PullDefaultResultBase {
	readonly repoUrl: string;
	readonly message: string;
}

export type PullDefaultResult =
	| PullDefaultAdvancedResult
	| PullDefaultRefusedNotFastForwardResult
	| PullDefaultFailedResult;

export interface PullDefaultAdvancedResult extends PullDefaultResultBase {
	readonly kind: 'advanced';
	readonly success: true;
	readonly defaultBranch: string;
	readonly remoteDefaultHead: string;
	readonly localDefaultHead: string;
	readonly currentBranch?: string | null;
	readonly fetchedCommits: readonly PullDefaultCommitSummary[];
	readonly commitsSinceForkPoint: readonly PullDefaultCommitSummary[];
	readonly currentBranchSync?: PullCurrentBranchSyncResult;
	readonly divergence: {
		readonly aheadOfDefault: number;
		readonly behindDefault: number;
		readonly forkPoint: string;
	};
}

export interface PullDefaultRefusedNotFastForwardResult extends PullDefaultResultBase {
	readonly kind: 'refused-not-fast-forward';
	readonly success: false;
	readonly error: string;
	readonly defaultBranch: string;
	readonly remoteDefaultHead: string;
}

export interface PullDefaultFailedResult extends PullDefaultResultBase {
	readonly kind: 'failed';
	readonly success: false;
	readonly error: string;
}

export type PullCurrentBranchSyncResult =
	| PullCurrentBranchAheadResult
	| PullCurrentBranchDefaultBranchResult
	| PullCurrentBranchDetachedResult
	| PullCurrentBranchDirtyWorktreeResult
	| PullCurrentBranchDivergedResult
	| PullCurrentBranchFastForwardedResult
	| PullCurrentBranchNoUpstreamResult
	| PullCurrentBranchUpToDateResult;

interface PullCurrentBranchBaseResult {
	readonly status:
		| 'ahead'
		| 'default-branch'
		| 'detached'
		| 'dirty-worktree'
		| 'diverged'
		| 'fast-forwarded'
		| 'no-upstream'
		| 'up-to-date';
	readonly branch: string | null;
	readonly upstreamTrackingRef: string | null;
}

export interface PullCurrentBranchAheadResult extends PullCurrentBranchBaseResult {
	readonly status: 'ahead';
	readonly branch: string;
	readonly upstreamTrackingRef: string;
	readonly localHead: string;
	readonly remoteHead: string;
	readonly reason: string;
}

export interface PullCurrentBranchDefaultBranchResult extends PullCurrentBranchBaseResult {
	readonly status: 'default-branch';
	readonly branch: string;
	readonly upstreamTrackingRef: string;
	readonly localHead: string;
	readonly remoteHead: string;
	readonly reason: string;
}

export interface PullCurrentBranchDetachedResult extends PullCurrentBranchBaseResult {
	readonly status: 'detached';
	readonly branch: null;
	readonly upstreamTrackingRef: null;
	readonly localHead: string;
	readonly reason: string;
}

export interface PullCurrentBranchDirtyWorktreeResult extends PullCurrentBranchBaseResult {
	readonly status: 'dirty-worktree';
	readonly branch: string;
	readonly upstreamTrackingRef: string;
	readonly localHead: string;
	readonly remoteHead: string;
	readonly reason: string;
}

export interface PullCurrentBranchDivergedResult extends PullCurrentBranchBaseResult {
	readonly status: 'diverged';
	readonly branch: string;
	readonly upstreamTrackingRef: string;
	readonly localHead: string;
	readonly remoteHead: string;
	readonly reason: string;
}

export interface PullCurrentBranchFastForwardedResult extends PullCurrentBranchBaseResult {
	readonly status: 'fast-forwarded';
	readonly branch: string;
	readonly upstreamTrackingRef: string;
	readonly localHead: string;
	readonly remoteHead: string;
}

export interface PullCurrentBranchNoUpstreamResult extends PullCurrentBranchBaseResult {
	readonly status: 'no-upstream';
	readonly branch: string;
	readonly upstreamTrackingRef: null;
	readonly localHead?: string;
	readonly reason: string;
}

export interface PullCurrentBranchUpToDateResult extends PullCurrentBranchBaseResult {
	readonly status: 'up-to-date';
	readonly branch: string;
	readonly upstreamTrackingRef: string;
	readonly localHead: string;
	readonly remoteHead: string;
}

export class PullDefaultValidationError extends Error {}

class GitCommandFailureError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'GitCommandFailureError';
	}
}

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
	return scrubGithubTokenFromOutput(error instanceof Error ? error.message : String(error));
}

async function git(options: {
	readonly args: readonly string[];
	readonly gitDir: HostGitDir;
	readonly reject?: boolean;
	readonly signal?: AbortSignal;
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
	const result = await execa(
		'git',
		buildHostGitArgs({ args: options.args, gitDir: options.gitDir }),
		{
			...(options.signal ? { cancelSignal: options.signal } : {}),
			env: { LANG: 'C', LC_ALL: 'C' },
			reject: false,
			timeout: GIT_OPERATION_TIMEOUT_MS,
		},
	);
	const terminatedWithoutExitCode = typeof result.exitCode !== 'number';
	const normalized = {
		stdout: result.stdout,
		stderr: terminatedWithoutExitCode
			? `${result.stderr}\ngit ${options.args.join(' ')} terminated without an exit code`.trim()
			: result.stderr,
		exitCode: typeof result.exitCode === 'number' ? result.exitCode : 128,
	};
	if (options.reject === true && normalized.exitCode !== 0) {
		throw new GitCommandFailureError(formatGitCommandFailure(options.args, normalized));
	}
	return normalized;
}

function formatGitCommandFailure(args: readonly string[], result: GitCommandResult): string {
	return scrubGithubTokenFromOutput(
		`git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`.trim(),
	);
}

async function gitWithTransientRetries(options: {
	readonly args: readonly string[];
	readonly gitDir: HostGitDir;
	readonly signal?: AbortSignal;
}): Promise<GitCommandResult> {
	const retryResult = await runGitCommandWithTransientRetries({
		run: async (signal) =>
			await git({
				args: options.args,
				gitDir: options.gitDir,
				reject: false,
				...(signal ? { signal } : {}),
			}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (retryResult.result.exitCode !== 0) {
		throw new GitCommandFailureError(formatGitCommandFailure(options.args, retryResult.result));
	}
	return retryResult.result;
}

async function updateRefAndVerify(options: {
	readonly expectedHead: string;
	readonly gitDir: HostGitDir;
	readonly ref: string;
	readonly signal?: AbortSignal;
	readonly sourceRef: string;
}): Promise<void> {
	await gitWithTransientRetries({
		gitDir: options.gitDir,
		args: ['update-ref', options.ref, options.sourceRef],
		...(options.signal ? { signal: options.signal } : {}),
	});
	const actualHead = (
		await git({
			gitDir: options.gitDir,
			args: ['rev-parse', options.ref],
			reject: true,
			...(options.signal ? { signal: options.signal } : {}),
		})
	).stdout.trim();
	if (actualHead !== options.expectedHead) {
		throw new GitCommandFailureError(
			`git update-ref ${options.ref} ${options.expectedHead} did not move the ref; ${options.ref} is at ${actualHead}`,
		);
	}
}

async function gitStdout(
	gitDir: HostGitDir,
	args: readonly string[],
	signal?: AbortSignal,
): Promise<string> {
	return (
		await gitWithTransientRetries({ args, gitDir, ...(signal ? { signal } : {}) })
	).stdout.trim();
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
	gitDir: HostGitDir,
	range: string,
	signal?: AbortSignal,
): Promise<readonly PullDefaultCommitSummary[]> {
	const result = await gitWithTransientRetries({
		gitDir,
		args: ['log', range, '--format=%H%x09%s%x09%an%x09%aI'],
		...(signal ? { signal } : {}),
	});
	return parseCommitSummaries(result.stdout);
}

async function refExists(gitDir: HostGitDir, ref: string, signal?: AbortSignal): Promise<boolean> {
	const args = ['rev-parse', '--verify', '--quiet', ref] as const;
	const result = await git({ gitDir, args, reject: false, ...(signal ? { signal } : {}) });
	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;
	throw new GitCommandFailureError(formatGitCommandFailure(args, result));
}

async function isAncestor(options: {
	readonly ancestorRef: string;
	readonly descendantRef: string;
	readonly gitDir: HostGitDir;
	readonly signal?: AbortSignal;
}): Promise<boolean> {
	const args = ['merge-base', '--is-ancestor', options.ancestorRef, options.descendantRef] as const;
	const result = await git({
		gitDir: options.gitDir,
		args,
		reject: false,
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;
	throw new GitCommandFailureError(formatGitCommandFailure(args, result));
}

async function countRange(
	gitDir: HostGitDir,
	range: string,
	signal?: AbortSignal,
): Promise<number> {
	const result = await gitWithTransientRetries({
		gitDir,
		args: ['rev-list', '--count', range],
		...(signal ? { signal } : {}),
	});
	const parsed = Number.parseInt(result.stdout.trim(), 10);
	if (Number.isNaN(parsed)) {
		throw new Error(`git rev-list --count ${range} returned non-numeric output: ${result.stdout}`);
	}
	return parsed;
}

async function fetchCurrentBranch(options: {
	readonly branch: string;
	readonly gitDir: HostGitDir;
	readonly githubToken: string;
	readonly repoUrl: string;
	readonly signal?: AbortSignal;
}): Promise<'fetched' | 'no-upstream'> {
	const authenticatedUrl = buildAuthenticatedGitUrl(options.repoUrl, options.githubToken);
	const upstreamProbeArgs = ['ls-remote', '--heads', authenticatedUrl, options.branch] as const;
	const upstreamProbe = await gitWithTransientRetries({
		gitDir: options.gitDir,
		args: upstreamProbeArgs,
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (upstreamProbe.stdout.trim().length === 0) {
		return 'no-upstream';
	}
	const remoteRef = `refs/remotes/origin/${options.branch}`;
	const fetchArgs = [
		'fetch',
		'--prune',
		authenticatedUrl,
		`refs/heads/${options.branch}:${remoteRef}`,
	] as const;
	await gitWithTransientRetries({
		gitDir: options.gitDir,
		args: fetchArgs,
		...(options.signal ? { signal: options.signal } : {}),
	});
	return 'fetched';
}

function describeCurrentBranchSync(sync: PullCurrentBranchSyncResult | undefined): string {
	if (!sync) {
		return 'No current branch was supplied by the worker, so only the default branch was refreshed.';
	}
	switch (sync.status) {
		case 'fast-forwarded':
			return `Current branch '${sync.branch}' fast-forwarded from ${sync.localHead} to ${sync.remoteHead}; the worker reset the worktree to materialize the new HEAD.`;
		case 'up-to-date':
			return `Current branch '${sync.branch}' was already up to date with ${sync.upstreamTrackingRef}.`;
		case 'ahead':
			return sync.reason;
		case 'default-branch':
			return sync.localHead === sync.remoteHead
				? `Current branch '${sync.branch}' is the default branch and was already at ${sync.remoteHead}.`
				: `Current branch '${sync.branch}' is the default branch; it fast-forwarded from ${sync.localHead} to ${sync.remoteHead}, and the worker reset the worktree to materialize the new HEAD.`;
		case 'detached':
			return sync.reason;
		case 'dirty-worktree':
			return sync.reason;
		case 'diverged':
			return sync.reason;
		case 'no-upstream':
			return sync.reason;
		default: {
			const exhaustiveStatus: never = sync;
			return `Unhandled current branch sync status: ${String(exhaustiveStatus)}`;
		}
	}
}

function buildAdvancedPullMessage(options: {
	readonly currentBranchSync: PullCurrentBranchSyncResult | undefined;
	readonly defaultBranch: string;
	readonly localDefaultHead: string;
	readonly remoteDefaultHead: string;
}): string {
	const defaultSummary =
		options.localDefaultHead === options.remoteDefaultHead
			? `Default branch '${options.defaultBranch}' is now at ${options.localDefaultHead}.`
			: `Default branch '${options.defaultBranch}' was refreshed, but local head ${options.localDefaultHead} differs from remote ${options.remoteDefaultHead}.`;
	return `${defaultSummary} ${describeCurrentBranchSync(options.currentBranchSync)}`;
}

async function recordControllerGitPullEvent(options: {
	readonly event: TaskEvent;
	readonly recordEvent: ((event: TaskEvent) => Promise<void>) | undefined;
}): Promise<void> {
	try {
		await options.recordEvent?.(options.event);
	} catch {
		writeControllerDiagnostic('git', {
			event: 'controller-operation-failed',
			level: 'warning',
			failureClass: 'failure',
			telemetry: {
				operation: 'record-controller-git-pull-event',
				outcome: options.event.event,
			},
		});
	}
}

async function recordControllerGitPullRefused(options: {
	readonly message: string;
	readonly recordEvent: ((event: TaskEvent) => Promise<void>) | undefined;
	readonly repoUrl: string;
}): Promise<void> {
	await recordControllerGitPullEvent({
		recordEvent: options.recordEvent,
		event: {
			event: 'controller-git-pull-failed',
			repoUrl: options.repoUrl,
			attempts: 0,
			message: options.message,
		},
	});
}

async function buildCurrentBranchSyncResult(options: {
	readonly defaultBranch: string;
	readonly gitDir: HostGitDir;
	readonly githubToken: string;
	readonly pullRequest: PullDefaultRequest;
	readonly repoUrl: string;
	readonly signal?: AbortSignal;
}): Promise<PullCurrentBranchSyncResult> {
	const branch = options.pullRequest.currentBranch;
	if (!branch) {
		const detachedHead =
			options.pullRequest.currentHead ??
			(await gitStdout(options.gitDir, ['rev-parse', 'HEAD'], options.signal));
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
		const localHead =
			options.pullRequest.currentHead ??
			(await gitStdout(options.gitDir, ['rev-parse', localRef], options.signal));
		const remoteHead = await gitStdout(options.gitDir, ['rev-parse', remoteRef], options.signal);
		return {
			branch,
			upstreamTrackingRef,
			status: 'default-branch',
			localHead,
			remoteHead,
			reason:
				localHead === remoteHead
					? `Current branch '${branch}' is the default branch and was already up to date.`
					: `Current branch '${branch}' is the default branch and was fast-forwarded from ${localHead} to ${remoteHead}.`,
		};
	}
	const fetchStatus = await fetchCurrentBranch({
		branch,
		gitDir: options.gitDir,
		githubToken: options.githubToken,
		repoUrl: options.repoUrl,
		...(options.signal ? { signal: options.signal } : {}),
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
		options.pullRequest.currentHead ??
		(await gitStdout(options.gitDir, ['rev-parse', localRef], options.signal));
	const remoteHead = await gitStdout(options.gitDir, ['rev-parse', remoteRef], options.signal);
	if (localHead === remoteHead) {
		return {
			branch,
			upstreamTrackingRef,
			status: 'up-to-date',
			localHead,
			remoteHead,
		};
	}
	const localAncestorOfRemote = await isAncestor({
		gitDir: options.gitDir,
		ancestorRef: localRef,
		descendantRef: remoteRef,
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (localAncestorOfRemote) {
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
		await updateRefAndVerify({
			gitDir: options.gitDir,
			ref: localRef,
			sourceRef: remoteRef,
			expectedHead: remoteHead,
			...(options.signal ? { signal: options.signal } : {}),
		});
		return {
			branch,
			upstreamTrackingRef,
			status: 'fast-forwarded',
			localHead,
			remoteHead,
		};
	}
	const remoteAncestorOfLocal = await isAncestor({
		gitDir: options.gitDir,
		ancestorRef: remoteRef,
		descendantRef: localRef,
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (remoteAncestorOfLocal) {
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
	readonly signal?: AbortSignal;
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
		const previousRemoteDefaultHead = (await refExists(
			repo.hostGitDir,
			remoteDefaultRef,
			options.signal,
		))
			? await gitStdout(repo.hostGitDir, ['rev-parse', remoteDefaultRef], options.signal)
			: null;
		await recordControllerGitPullEvent({
			recordEvent: options.recordEvent,
			event: {
				event: 'controller-git-pull-started',
				repoUrl: options.repoUrl,
			},
		});
		const fetchArgs = [
			'fetch',
			'--prune',
			buildAuthenticatedGitUrl(options.repoUrl, options.githubToken),
			`${defaultBranch}:${remoteDefaultRef}`,
		] as const;
		const fetchRetryResult = await runGitCommandWithTransientRetries({
			run: async (signal) =>
				await git({
					gitDir: repo.hostGitDir,
					args: fetchArgs,
					reject: false,
					...(signal ? { signal } : {}),
				}),
			onRetry: async ({ attempt, delayMs, result }) => {
				const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
				await recordControllerGitPullEvent({
					recordEvent: options.recordEvent,
					event: {
						event: 'controller-git-pull-retry',
						repoUrl: options.repoUrl,
						attempts: attempt,
						message: detail,
						retryDelaySeconds: delayMs / 1000,
					},
				});
			},
			...(options.signal ? { signal: options.signal } : {}),
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

		const remoteDefaultHead = await gitStdout(
			repo.hostGitDir,
			['rev-parse', remoteDefaultRef],
			options.signal,
		);
		const fetchedCommits = previousRemoteDefaultHead
			? await commitSummaries(
					repo.hostGitDir,
					`${previousRemoteDefaultHead}..${remoteDefaultRef}`,
					options.signal,
				)
			: [];

		if (!(await refExists(repo.hostGitDir, defaultRef, options.signal))) {
			const message = `Local default branch ref '${defaultRef}' is missing; controller refused to create it during git-pull-default. Recreate the task or inspect the host gitdir.`;
			await recordControllerGitPullRefused({
				recordEvent: options.recordEvent,
				repoUrl: options.repoUrl,
				message,
			});
			return {
				kind: 'refused-not-fast-forward',
				repoUrl: options.repoUrl,
				success: false,
				message,
				defaultBranch,
				remoteDefaultHead,
				error: message,
			};
		}
		{
			const fastForwardCheck = await isAncestor({
				gitDir: repo.hostGitDir,
				ancestorRef: defaultRef,
				descendantRef: remoteDefaultRef,
				...(options.signal ? { signal: options.signal } : {}),
			});
			if (!fastForwardCheck) {
				const message = `Local ${defaultBranch} cannot be fast-forwarded to origin/${defaultBranch}; inspect it manually.`;
				await recordControllerGitPullRefused({
					recordEvent: options.recordEvent,
					repoUrl: options.repoUrl,
					message,
				});
				return {
					kind: 'refused-not-fast-forward',
					repoUrl: options.repoUrl,
					success: false,
					message,
					defaultBranch,
					remoteDefaultHead,
					error: message,
				};
			}
		}
		const previousLocalDefaultHead = await gitStdout(
			repo.hostGitDir,
			['rev-parse', defaultRef],
			options.signal,
		);
		if (
			options.currentBranch === defaultBranch &&
			options.worktreeDirty === true &&
			previousLocalDefaultHead !== remoteDefaultHead
		) {
			const message = `Current branch '${defaultBranch}' is the default branch and can fast-forward to origin/${defaultBranch}, but the worker worktree has uncommitted changes. Commit or stash before calling git-pull-default.`;
			await recordControllerGitPullRefused({
				recordEvent: options.recordEvent,
				repoUrl: options.repoUrl,
				message,
			});
			return {
				kind: 'refused-not-fast-forward',
				repoUrl: options.repoUrl,
				success: false,
				message,
				defaultBranch,
				remoteDefaultHead,
				error: message,
			};
		}

		await updateRefAndVerify({
			gitDir: repo.hostGitDir,
			ref: defaultRef,
			sourceRef: remoteDefaultRef,
			expectedHead: remoteDefaultHead,
			...(options.signal ? { signal: options.signal } : {}),
		});
		const localDefaultHead = await gitStdout(
			repo.hostGitDir,
			['rev-parse', defaultRef],
			options.signal,
		);
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
					...(options.signal ? { signal: options.signal } : {}),
				})
			: undefined;
		const currentHeadRef = options.currentHead ?? 'HEAD';
		const effectiveCurrentHeadRef =
			currentBranchSync?.status === 'fast-forwarded' ||
			currentBranchSync?.status === 'default-branch'
				? currentBranchSync.remoteHead
				: currentHeadRef;
		const forkPoint = await gitStdout(
			repo.hostGitDir,
			['merge-base', effectiveCurrentHeadRef, remoteDefaultRef],
			options.signal,
		);
		const commitsSinceForkPoint = await commitSummaries(
			repo.hostGitDir,
			`${forkPoint}..${remoteDefaultRef}`,
			options.signal,
		);

		const message = buildAdvancedPullMessage({
			currentBranchSync,
			defaultBranch,
			localDefaultHead,
			remoteDefaultHead,
		});
		const result = {
			kind: 'advanced',
			repoUrl: options.repoUrl,
			success: true,
			message,
			defaultBranch,
			remoteDefaultHead,
			localDefaultHead,
			...(options.currentBranch !== undefined ? { currentBranch: options.currentBranch } : {}),
			...(currentBranchSync ? { currentBranchSync } : {}),
			fetchedCommits,
			commitsSinceForkPoint,
			divergence: {
				aheadOfDefault: await countRange(
					repo.hostGitDir,
					`${remoteDefaultRef}..${effectiveCurrentHeadRef}`,
					options.signal,
				),
				behindDefault: await countRange(
					repo.hostGitDir,
					`${effectiveCurrentHeadRef}..${remoteDefaultRef}`,
					options.signal,
				),
				forkPoint,
			},
		} satisfies PullDefaultAdvancedResult;
		await recordControllerGitPullEvent({
			recordEvent: options.recordEvent,
			event: {
				event: 'controller-git-pull-succeeded',
				repoUrl: options.repoUrl,
				attempts: fetchRetryResult.attempts,
				defaultBranch,
				remoteDefaultHead,
				localDefaultHead,
			},
		});
		return result;
	} catch (error) {
		if (
			!(error instanceof GitPullFailedAfterRetriesError) &&
			!(error instanceof GitCommandFailureError)
		) {
			throw error;
		}
		const retryAfterSeconds =
			error instanceof GitPullFailedAfterRetriesError && error.attempts > 1
				? GIT_PULL_RETRY_AFTER_SECONDS
				: undefined;
		const message = errorMessage(error);
		await recordControllerGitPullEvent({
			recordEvent: options.recordEvent,
			event: {
				event: 'controller-git-pull-failed',
				repoUrl: options.repoUrl,
				attempts: error instanceof GitPullFailedAfterRetriesError ? error.attempts : 0,
				message,
				...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
			},
		});
		return {
			kind: 'failed',
			repoUrl: options.repoUrl,
			success: false,
			message,
			error: message,
		};
	}
}
