import type { TaskEvent } from '@agent-vm/agent-vm-worker';
import { execa } from 'execa';

import type { ActiveWorkerTask } from './active-task-registry.js';
import { scrubGithubTokenFromOutput } from './git-auth-support.js';
import { runGitCommandWithTransientRetries, type GitCommandResult } from './git-retry-support.js';

const GIT_OPERATION_TIMEOUT_MS = 120_000;
const GIT_PUSH_RETRY_AFTER_MESSAGE =
	'GitHub or the network is still rejecting the push after retries. Try git-push again in 5 minutes if the task is still running; otherwise start a new task.';
const GIT_PUSH_RETRY_AFTER_SECONDS = 300;

export interface PushBranchRequest {
	readonly repoUrl: string;
	readonly branchName: string;
}

export interface PushCommitSummary {
	readonly sha: string;
	readonly subject: string;
	readonly author?: string;
	readonly date?: string;
}

interface MutablePushCommitSummary {
	sha: string;
	subject: string;
	author?: string;
	date?: string;
}

export interface PushBranchResult {
	readonly repoUrl: string;
	readonly branch: string;
	readonly success: boolean;
	readonly error?: string;
	readonly localHead?: string;
	readonly remoteBranchHead?: string;
	readonly defaultBranch?: string;
	readonly remoteDefaultHead?: string;
	readonly commitsOnBranch?: readonly PushCommitSummary[];
	readonly pushedInThisCall?: readonly PushCommitSummary[];
	readonly remoteAlreadyHadBranch?: boolean;
	readonly divergence?: { readonly aheadOfDefault: number; readonly behindDefault: number };
}

export class PushBranchesValidationError extends Error {}

class GitPushFailedAfterRetriesError extends Error {
	public constructor(
		message: string,
		public readonly attempts: number,
		public readonly phase: 'pre-push-fetch' | 'push' | 'post-push-fetch',
	) {
		super(message);
		this.name = 'GitPushFailedAfterRetriesError';
	}
}

function writePushFlowLog(message: string): void {
	process.stderr.write(`[git-push-operations] ${message}\n`);
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

function parseRepoFromUrl(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/, '');
	const urlPattern = /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)$/u;
	const match = urlPattern.exec(cleaned);

	if (match?.[1]) {
		return match[1];
	}
	if (/^[^\s/]+\/[^\s/]+$/u.test(cleaned)) {
		return cleaned;
	}

	throw new PushBranchesValidationError(`Invalid GitHub repository: ${repoUrl}`);
}

function buildPushUrl(repoUrl: string, githubToken: string): string {
	return `https://x-access-token:${githubToken}@github.com/${parseRepoFromUrl(repoUrl)}.git`;
}

function sanitizeBranchName(name: string): string {
	return name.replace(/[^a-zA-Z0-9\-_./]/gu, '-');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function recordPushEvent(options: {
	readonly event: TaskEvent;
	readonly recordEvent: ((event: TaskEvent) => Promise<void>) | undefined;
}): Promise<void> {
	try {
		await options.recordEvent?.(options.event);
	} catch (error) {
		writePushFlowLog(
			`Failed to record ${options.event.event}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function git(options: {
	readonly args: readonly string[];
	readonly gitDir: string;
	readonly reject?: boolean;
}): Promise<GitCommandResult> {
	const result = await execa(
		'git',
		['-c', 'core.hooksPath=/dev/null', `--git-dir=${options.gitDir}`, ...options.args],
		{
			reject: false,
			timeout: GIT_OPERATION_TIMEOUT_MS,
		},
	);
	const terminatedWithoutExitCode = typeof result.exitCode !== 'number';
	const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 128;
	const normalized = {
		stdout: result.stdout,
		stderr: terminatedWithoutExitCode
			? `${result.stderr}\ngit ${options.args.join(' ')} terminated without an exit code`.trim()
			: result.stderr,
		exitCode,
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

function parseCommitSummaries(output: string): readonly PushCommitSummary[] {
	if (output.trim().length === 0) return [];
	return output
		.trim()
		.split('\n')
		.map((line) => {
			const [sha = '', subject = '', author = '', date = ''] = line.split('\t');
			const summary: MutablePushCommitSummary = {
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
	options?: { readonly includeAuthorDate?: boolean },
): Promise<readonly PushCommitSummary[]> {
	const format = options?.includeAuthorDate === true ? '%H%x09%s%x09%an%x09%aI' : '%H%x09%s';
	const result = await gitWithTransientRetries({
		gitDir,
		args: ['log', range, `--format=${format}`],
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

async function fetchRemoteRefs(options: {
	readonly gitDir: string;
	readonly defaultBranch: string;
	readonly repoUrl: string;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
}): Promise<void> {
	const pushUrl = buildPushUrl(options.repoUrl, options.githubToken);
	const retryResult = await runGitCommandWithTransientRetries({
		run: async () =>
			await git({
				gitDir: options.gitDir,
				args: [
					'fetch',
					'--prune',
					pushUrl,
					`${options.defaultBranch}:refs/remotes/origin/${options.defaultBranch}`,
				],
				reject: false,
			}),
		onRetry: async ({ attempt, delayMs, result }) => {
			const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
			writePushFlowLog(
				`git fetch failed for ${options.repoUrl} ${options.defaultBranch} on attempt ${attempt}; retrying in ${delayMs / 1000}s: ${detail}`,
			);
			await recordPushEvent({
				recordEvent: options.recordEvent,
				event: {
					event: 'controller-git-push-fetch-retry',
					repoUrl: options.repoUrl,
					branch: options.defaultBranch,
					attempts: attempt,
					message: detail,
					retryDelaySeconds: delayMs / 1000,
				},
			});
		},
	});
	if (retryResult.result.exitCode !== 0) {
		const detail = scrubGithubTokenFromOutput(
			`${retryResult.result.stdout}\n${retryResult.result.stderr}`,
		).trim();
		const message =
			retryResult.attempts > 1
				? `git fetch failed\n${GIT_PUSH_RETRY_AFTER_MESSAGE}\n${detail}`
				: `git fetch failed\n${detail}`;
		throw new GitPushFailedAfterRetriesError(message, retryResult.attempts, 'pre-push-fetch');
	}
}

async function remoteBranchHead(gitDir: string, branchName: string): Promise<string | null> {
	if (!(await refExists(gitDir, `refs/remotes/origin/${branchName}`))) return null;
	return await gitStdout(gitDir, ['rev-parse', `refs/remotes/origin/${branchName}`]);
}

async function pushBranch(options: {
	readonly repoUrl: string;
	readonly branchName: string;
	readonly gitDir: string;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
}): Promise<{ readonly attempts: number }> {
	const sanitizedBranchName = sanitizeBranchName(options.branchName);
	const pushArgs = [
		'push',
		buildPushUrl(options.repoUrl, options.githubToken),
		`${sanitizedBranchName}:refs/heads/${sanitizedBranchName}`,
	] as const;
	const retryResult = await runGitCommandWithTransientRetries({
		run: async () =>
			await git({
				gitDir: options.gitDir,
				args: pushArgs,
				reject: false,
			}),
		onRetry: async ({ attempt, delayMs, result }) => {
			const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
			writePushFlowLog(
				`git push failed for ${options.repoUrl} ${sanitizedBranchName} on attempt ${attempt}; retrying in ${delayMs / 1000}s: ${detail}`,
			);
			await recordPushEvent({
				recordEvent: options.recordEvent,
				event: {
					event: 'controller-git-push-retry',
					repoUrl: options.repoUrl,
					branch: sanitizedBranchName,
					attempts: attempt,
					message: detail,
					retryDelaySeconds: delayMs / 1000,
				},
			});
		},
		sleep,
	});

	if (retryResult.result.exitCode === 0) {
		return { attempts: retryResult.attempts };
	}

	const lastErrorDetail = scrubGithubTokenFromOutput(
		`${retryResult.result.stdout}\n${retryResult.result.stderr}`,
	).trim();
	writePushFlowLog(
		`git push failed for ${options.repoUrl} ${sanitizedBranchName} after ${retryResult.attempts} attempts: ${lastErrorDetail}`,
	);
	const failureMessage =
		retryResult.attempts > 1
			? `git push failed\n${GIT_PUSH_RETRY_AFTER_MESSAGE}\n${lastErrorDetail}`
			: `git push failed\n${lastErrorDetail}`;
	throw new GitPushFailedAfterRetriesError(failureMessage, retryResult.attempts, 'push');
}

async function fetchPushedBranchRef(options: {
	readonly gitDir: string;
	readonly repoUrl: string;
	readonly branchName: string;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
}): Promise<void> {
	const retryResult = await runGitCommandWithTransientRetries({
		run: async () =>
			await git({
				gitDir: options.gitDir,
				args: [
					'fetch',
					'--prune',
					buildPushUrl(options.repoUrl, options.githubToken),
					`${options.branchName}:refs/remotes/origin/${options.branchName}`,
				],
				reject: false,
			}),
		onRetry: async ({ attempt, delayMs, result }) => {
			const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
			writePushFlowLog(
				`post-push git fetch failed for ${options.repoUrl} ${options.branchName} on attempt ${attempt}; retrying in ${delayMs / 1000}s: ${detail}`,
			);
			await recordPushEvent({
				recordEvent: options.recordEvent,
				event: {
					event: 'controller-git-push-fetch-retry',
					repoUrl: options.repoUrl,
					branch: options.branchName,
					attempts: attempt,
					message: detail,
					retryDelaySeconds: delayMs / 1000,
				},
			});
		},
		sleep,
	});
	if (retryResult.result.exitCode !== 0) {
		const detail = scrubGithubTokenFromOutput(
			`${retryResult.result.stdout}\n${retryResult.result.stderr}`,
		).trim();
		const message =
			retryResult.attempts > 1
				? `git fetch failed\n${GIT_PUSH_RETRY_AFTER_MESSAGE}\n${detail}`
				: `git fetch failed\n${detail}`;
		throw new GitPushFailedAfterRetriesError(message, retryResult.attempts, 'post-push-fetch');
	}
}

function parseCountRangeOutput(output: string, range: string): number {
	const parsed = Number.parseInt(output.trim(), 10);
	if (Number.isNaN(parsed)) {
		throw new Error(`git rev-list --count ${range} returned non-numeric output: ${output}`);
	}
	return parsed;
}

async function countRange(gitDir: string, range: string): Promise<number> {
	const result = await gitWithTransientRetries({
		gitDir,
		args: ['rev-list', '--count', range],
	});
	return parseCountRangeOutput(result.stdout, range);
}

async function buildBranchState(options: {
	readonly gitDir: string;
	readonly branchName: string;
	readonly defaultBranch: string;
	readonly previousRemoteBranchHead: string | null;
}): Promise<Omit<PushBranchResult, 'repoUrl' | 'branch' | 'success'>> {
	const localHead = await gitStdout(options.gitDir, ['rev-parse', 'HEAD']);
	const pushedRemoteBranchHead = await remoteBranchHead(options.gitDir, options.branchName);
	const remoteDefaultRef = `refs/remotes/origin/${options.defaultBranch}`;
	const remoteDefaultHead = (await refExists(options.gitDir, remoteDefaultRef))
		? await gitStdout(options.gitDir, ['rev-parse', remoteDefaultRef])
		: '';
	const defaultRange = remoteDefaultHead ? `${remoteDefaultRef}..HEAD` : '';
	const commitsOnBranch = defaultRange
		? await commitSummaries(options.gitDir, defaultRange, { includeAuthorDate: true })
		: [];
	const pushedRange = options.previousRemoteBranchHead
		? `${options.previousRemoteBranchHead}..HEAD`
		: defaultRange;
	const pushedInThisCall = pushedRange ? await commitSummaries(options.gitDir, pushedRange) : [];
	const divergence = remoteDefaultHead
		? {
				aheadOfDefault: await countRange(options.gitDir, `${remoteDefaultRef}..HEAD`),
				behindDefault: await countRange(options.gitDir, `HEAD..${remoteDefaultRef}`),
			}
		: { aheadOfDefault: 0, behindDefault: 0 };

	return {
		localHead,
		...(pushedRemoteBranchHead ? { remoteBranchHead: pushedRemoteBranchHead } : {}),
		defaultBranch: options.defaultBranch,
		remoteDefaultHead,
		commitsOnBranch,
		pushedInThisCall,
		remoteAlreadyHadBranch: options.previousRemoteBranchHead !== null,
		divergence,
	};
}

export async function pushBranchesForTask(options: {
	readonly activeTask: ActiveWorkerTask;
	readonly branches: readonly PushBranchRequest[];
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
}): Promise<{ readonly results: readonly PushBranchResult[] }> {
	const requestedRepoUrls = new Set<string>();
	const reposByUrl = new Map(options.activeTask.repos.map((repo) => [repo.repoUrl, repo] as const));
	for (const branch of options.branches) {
		if (!branch.branchName.startsWith(options.activeTask.branchPrefix)) {
			throw new PushBranchesValidationError(
				`Branch '${branch.branchName}' must start with '${options.activeTask.branchPrefix}'.`,
			);
		}
		if (requestedRepoUrls.has(branch.repoUrl)) {
			throw new PushBranchesValidationError(
				`Repo '${branch.repoUrl}' has multiple push requests. Push one branch per repo per request.`,
			);
		}
		requestedRepoUrls.add(branch.repoUrl);
		const repo = reposByUrl.get(branch.repoUrl);
		if (!repo) {
			throw new PushBranchesValidationError(
				`Repo '${branch.repoUrl}' is not registered for active task '${options.activeTask.taskId}'.`,
			);
		}
	}

	const pushResults = await Promise.allSettled(
		options.branches.map(async (branch) => {
			const repo = reposByUrl.get(branch.repoUrl);
			if (!repo) throw new Error(`Validated repo '${branch.repoUrl}' disappeared before push.`);
			return await pushOneBranchForTask({
				branch,
				githubToken: options.githubToken,
				...(options.recordEvent ? { recordEvent: options.recordEvent } : {}),
				repo,
				task: options.activeTask,
			});
		}),
	);
	const results = pushResults.map((result, index): PushBranchResult => {
		if (result.status === 'fulfilled') return result.value;
		const branch = options.branches[index];
		return {
			repoUrl: branch?.repoUrl ?? 'unknown',
			branch: sanitizeBranchName(branch?.branchName ?? 'unknown'),
			success: false,
			error: errorMessage(result.reason),
		};
	});

	return { results };
}

async function pushOneBranchForTask(options: {
	readonly branch: PushBranchRequest;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
	readonly repo: ActiveWorkerTask['repos'][number];
	readonly task: ActiveWorkerTask;
}): Promise<PushBranchResult> {
	const branchName = sanitizeBranchName(options.branch.branchName);
	let pushAttempts = 0;
	try {
		if (branchName === options.repo.baseBranch) {
			return {
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				success: false,
				error: `Refusing to push: you are on the default branch "${options.repo.baseBranch}". Create an ${options.task.branchPrefix} branch first and move your commits to it.`,
			};
		}
		await recordPushEvent({
			recordEvent: options.recordEvent,
			event: {
				event: 'controller-git-push-started',
				repoUrl: options.branch.repoUrl,
				branch: branchName,
			},
		});

		await fetchRemoteRefs({
			gitDir: options.repo.hostGitDir,
			defaultBranch: options.repo.baseBranch,
			repoUrl: options.branch.repoUrl,
			githubToken: options.githubToken,
			...(options.recordEvent ? { recordEvent: options.recordEvent } : {}),
		});
		const previousRemoteBranchHead = await remoteBranchHead(options.repo.hostGitDir, branchName);
		const localHead = await gitStdout(options.repo.hostGitDir, ['rev-parse', 'HEAD']);
		if (previousRemoteBranchHead === localHead) {
			return {
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				success: false,
				error: `Nothing new to push on ${branchName}. Local HEAD matches origin/${branchName} (${localHead}). Commit your work and call git-push again.`,
			};
		}

		const pushResult = await pushBranch({
			repoUrl: options.branch.repoUrl,
			branchName,
			gitDir: options.repo.hostGitDir,
			githubToken: options.githubToken,
			...(options.recordEvent ? { recordEvent: options.recordEvent } : {}),
		});
		pushAttempts = pushResult.attempts;
		await fetchPushedBranchRef({
			gitDir: options.repo.hostGitDir,
			repoUrl: options.branch.repoUrl,
			branchName,
			githubToken: options.githubToken,
			...(options.recordEvent ? { recordEvent: options.recordEvent } : {}),
		});
		const state = await buildBranchState({
			gitDir: options.repo.hostGitDir,
			branchName,
			defaultBranch: options.repo.baseBranch,
			previousRemoteBranchHead,
		});
		await recordPushEvent({
			recordEvent: options.recordEvent,
			event: {
				event: 'controller-git-push-succeeded',
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				attempts: pushAttempts,
				...(state.localHead ? { localHead: state.localHead } : {}),
				...(state.remoteBranchHead ? { remoteBranchHead: state.remoteBranchHead } : {}),
			},
		});
		return {
			repoUrl: options.branch.repoUrl,
			branch: branchName,
			success: true,
			...state,
		};
	} catch (error) {
		const message = errorMessage(error);
		const attempts =
			error instanceof GitPushFailedAfterRetriesError ? error.attempts : pushAttempts;
		const retryAfterSeconds =
			error instanceof GitPushFailedAfterRetriesError && error.attempts > 1
				? GIT_PUSH_RETRY_AFTER_SECONDS
				: undefined;
		const phase = error instanceof GitPushFailedAfterRetriesError ? error.phase : undefined;
		await recordPushEvent({
			recordEvent: options.recordEvent,
			event: {
				event: 'controller-git-push-failed',
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				attempts,
				message,
				...(phase !== undefined ? { phase } : {}),
				...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
			},
		});
		return {
			repoUrl: options.branch.repoUrl,
			branch: branchName,
			success: false,
			error: message,
		};
	}
}
