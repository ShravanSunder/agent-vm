import type { ControllerGitPushPhase, TaskEvent } from '@agent-vm/agent-vm-worker';
import { execa } from 'execa';

import type { ActiveWorkerTask, HostGitDir } from './active-task-registry.js';
import { writeControllerDiagnostic } from './controller-diagnostic-logging.js';
import {
	buildGithubTokenUrl,
	GitHubRepositoryValidationError,
	scrubGithubTokenFromOutput,
} from './git-auth-support.js';
import { runGitCommandWithTransientRetries, type GitCommandResult } from './git-retry-support.js';
import { buildHostGitArgs } from './host-git-command.js';

const GIT_OPERATION_TIMEOUT_MS = 120_000;
const GIT_PUSH_RETRY_AFTER_MESSAGE =
	'GitHub or the network is still rejecting the push after retries. Try git-push again in 5 minutes; the controller retains task state while the task remains registered.';
const GIT_PUSH_RETRY_AFTER_SECONDS = 300;

export interface PushBranchRequest {
	readonly repoUrl: string;
	readonly branchName: string;
	readonly expectedHead?: string;
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
		public readonly phase: ControllerGitPushPhase,
	) {
		super(message);
		this.name = 'GitPushFailedAfterRetriesError';
	}
}

type GitPushDiagnosticOperation =
	| 'fetch-default-branch-retry'
	| 'fetch-pushed-branch-retry'
	| 'push-branch-failed'
	| 'push-branch-retry'
	| 'record-controller-git-event';

function writePushFlowLog(
	operation: GitPushDiagnosticOperation,
	attempt?: number,
	outcome?: string,
): void {
	writeControllerDiagnostic('git', {
		event: 'controller-operation-failed',
		level: 'warning',
		failureClass: 'failure',
		telemetry: {
			operation,
			...(attempt === undefined ? {} : { attempt }),
			...(outcome === undefined ? {} : { outcome }),
		},
	});
}

function buildPushUrl(repoUrl: string, githubToken: string): string {
	try {
		return buildGithubTokenUrl(repoUrl, githubToken);
	} catch (error) {
		if (error instanceof GitHubRepositoryValidationError) {
			throw new PushBranchesValidationError(error.message);
		}
		throw error;
	}
}

function sanitizeBranchName(name: string): string {
	return name.replace(/[^a-zA-Z0-9\-_./]/gu, '-');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function gitBranchPatternMatches(pattern: string, branch: string): boolean {
	const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'u');
	return regex.test(branch);
}

function protectedBranchPolicyDescription(options: {
	readonly branchName: string;
	readonly pushPolicy: Extract<
		ActiveWorkerTask['repos'][number]['pushPolicy'],
		{ readonly kind: 'trusted_config' }
	>;
}): string | undefined {
	if (new Set(options.pushPolicy.protectedBranches).has(options.branchName)) {
		return `protected branch "${options.branchName}"`;
	}
	if (options.pushPolicy.defaultBranch === options.branchName) {
		return `protected default branch "${options.branchName}"`;
	}
	const protectedBranchPattern = options.pushPolicy.protectedBranchPatterns.find((pattern) =>
		gitBranchPatternMatches(pattern, options.branchName),
	);
	return protectedBranchPattern === undefined
		? undefined
		: `protected branch pattern "${protectedBranchPattern}"`;
}

function errorMessage(error: unknown): string {
	return scrubGithubTokenFromOutput(error instanceof Error ? error.message : String(error));
}

async function recordPushEvent(options: {
	readonly event: TaskEvent;
	readonly recordEvent: ((event: TaskEvent) => Promise<void>) | undefined;
}): Promise<void> {
	try {
		await options.recordEvent?.(options.event);
	} catch {
		writePushFlowLog('record-controller-git-event', undefined, options.event.event);
	}
}

async function git(options: {
	readonly args: readonly string[];
	readonly gitDir: HostGitDir;
	readonly reject?: boolean;
	readonly signal?: AbortSignal;
}): Promise<GitCommandResult> {
	const result = await execa(
		'git',
		buildHostGitArgs({ args: options.args, gitDir: options.gitDir }),
		{
			...(options.signal ? { cancelSignal: options.signal } : {}),
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
		throw new Error(formatGitCommandFailure(options.args, retryResult.result));
	}
	return retryResult.result;
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
	gitDir: HostGitDir,
	range: string,
	options?: { readonly includeAuthorDate?: boolean; readonly signal?: AbortSignal },
): Promise<readonly PushCommitSummary[]> {
	const format = options?.includeAuthorDate === true ? '%H%x09%s%x09%an%x09%aI' : '%H%x09%s';
	const result = await gitWithTransientRetries({
		gitDir,
		args: ['log', range, `--format=${format}`],
		...(options?.signal ? { signal: options.signal } : {}),
	});
	return parseCommitSummaries(result.stdout);
}

async function refExists(gitDir: HostGitDir, ref: string, signal?: AbortSignal): Promise<boolean> {
	const args = ['rev-parse', '--verify', '--quiet', ref] as const;
	const result = await git({ gitDir, args, reject: false, ...(signal ? { signal } : {}) });
	if (result.exitCode === 0) return true;
	if (result.stderr.trim().length > 0) {
		throw new Error(formatGitCommandFailure(args, result));
	}
	return false;
}

async function fetchRemoteRefs(options: {
	readonly gitDir: HostGitDir;
	readonly defaultBranch: string;
	readonly repoUrl: string;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
	readonly signal?: AbortSignal;
}): Promise<void> {
	const pushUrl = buildPushUrl(options.repoUrl, options.githubToken);
	const retryResult = await runGitCommandWithTransientRetries({
		run: async (signal) =>
			await git({
				gitDir: options.gitDir,
				args: [
					'fetch',
					'--prune',
					pushUrl,
					`${options.defaultBranch}:refs/remotes/origin/${options.defaultBranch}`,
				],
				reject: false,
				...(signal ? { signal } : {}),
			}),
		onRetry: async ({ attempt, delayMs, result }) => {
			const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
			writePushFlowLog('fetch-default-branch-retry', attempt);
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
		...(options.signal ? { signal: options.signal } : {}),
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

async function remoteBranchHead(
	gitDir: HostGitDir,
	branchName: string,
	signal?: AbortSignal,
): Promise<string | null> {
	if (!(await refExists(gitDir, `refs/remotes/origin/${branchName}`, signal))) return null;
	return await gitStdout(gitDir, ['rev-parse', `refs/remotes/origin/${branchName}`], signal);
}

async function pushBranch(options: {
	readonly repoUrl: string;
	readonly branchName: string;
	readonly gitDir: HostGitDir;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
	readonly signal?: AbortSignal;
}): Promise<{ readonly attempts: number }> {
	const sanitizedBranchName = sanitizeBranchName(options.branchName);
	const pushArgs = [
		'push',
		buildPushUrl(options.repoUrl, options.githubToken),
		`${sanitizedBranchName}:refs/heads/${sanitizedBranchName}`,
	] as const;
	const retryResult = await runGitCommandWithTransientRetries({
		run: async (signal) =>
			await git({
				gitDir: options.gitDir,
				args: pushArgs,
				reject: false,
				...(signal ? { signal } : {}),
			}),
		onRetry: async ({ attempt, delayMs, result }) => {
			const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
			writePushFlowLog('push-branch-retry', attempt);
			await recordPushEvent({
				recordEvent: options.recordEvent,
				event: {
					event: 'controller-git-push-retry',
					repoUrl: options.repoUrl,
					branch: sanitizedBranchName,
					attempts: attempt,
					message: detail,
					phase: 'push',
					retryDelaySeconds: delayMs / 1000,
				},
			});
		},
		...(options.signal ? { signal: options.signal } : {}),
	});

	if (retryResult.result.exitCode === 0) {
		return { attempts: retryResult.attempts };
	}

	const lastErrorDetail = scrubGithubTokenFromOutput(
		`${retryResult.result.stdout}\n${retryResult.result.stderr}`,
	).trim();
	writePushFlowLog('push-branch-failed', retryResult.attempts);
	const failureMessage =
		retryResult.attempts > 1
			? `git push failed\n${GIT_PUSH_RETRY_AFTER_MESSAGE}\n${lastErrorDetail}`
			: `git push failed\n${lastErrorDetail}`;
	throw new GitPushFailedAfterRetriesError(failureMessage, retryResult.attempts, 'push');
}

async function fetchPushedBranchRef(options: {
	readonly gitDir: HostGitDir;
	readonly repoUrl: string;
	readonly branchName: string;
	readonly githubToken: string;
	readonly recordEvent?: (event: TaskEvent) => Promise<void>;
	readonly signal?: AbortSignal;
}): Promise<void> {
	const retryResult = await runGitCommandWithTransientRetries({
		run: async (signal) =>
			await git({
				gitDir: options.gitDir,
				args: [
					'fetch',
					'--prune',
					buildPushUrl(options.repoUrl, options.githubToken),
					`${options.branchName}:refs/remotes/origin/${options.branchName}`,
				],
				reject: false,
				...(signal ? { signal } : {}),
			}),
		onRetry: async ({ attempt, delayMs, result }) => {
			const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
			writePushFlowLog('fetch-pushed-branch-retry', attempt);
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
		...(options.signal ? { signal: options.signal } : {}),
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
	return parseCountRangeOutput(result.stdout, range);
}

async function buildBranchState(options: {
	readonly gitDir: HostGitDir;
	readonly branchName: string;
	readonly defaultBranch: string;
	readonly previousRemoteBranchHead: string | null;
	readonly signal?: AbortSignal;
}): Promise<Omit<PushBranchResult, 'repoUrl' | 'branch' | 'success'>> {
	const localHead = await gitStdout(options.gitDir, ['rev-parse', 'HEAD'], options.signal);
	const pushedRemoteBranchHead = await remoteBranchHead(
		options.gitDir,
		options.branchName,
		options.signal,
	);
	const remoteDefaultRef = `refs/remotes/origin/${options.defaultBranch}`;
	const remoteDefaultHead = (await refExists(options.gitDir, remoteDefaultRef, options.signal))
		? await gitStdout(options.gitDir, ['rev-parse', remoteDefaultRef], options.signal)
		: '';
	const defaultRange = remoteDefaultHead ? `${remoteDefaultRef}..HEAD` : '';
	const commitsOnBranch = defaultRange
		? await commitSummaries(
				options.gitDir,
				defaultRange,
				options.signal
					? { includeAuthorDate: true, signal: options.signal }
					: { includeAuthorDate: true },
			)
		: [];
	const pushedRange = options.previousRemoteBranchHead
		? `${options.previousRemoteBranchHead}..HEAD`
		: defaultRange;
	const pushedInThisCall = pushedRange
		? await commitSummaries(
				options.gitDir,
				pushedRange,
				options.signal ? { signal: options.signal } : undefined,
			)
		: [];
	const divergence = remoteDefaultHead
		? {
				aheadOfDefault: await countRange(
					options.gitDir,
					`${remoteDefaultRef}..HEAD`,
					options.signal,
				),
				behindDefault: await countRange(
					options.gitDir,
					`HEAD..${remoteDefaultRef}`,
					options.signal,
				),
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
	readonly signal?: AbortSignal;
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
				...(options.signal ? { signal: options.signal } : {}),
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
	readonly signal?: AbortSignal;
	readonly task: ActiveWorkerTask;
}): Promise<PushBranchResult> {
	const branchName = sanitizeBranchName(options.branch.branchName);
	let pushAttempts = 0;
	try {
		const pushPolicy = options.repo.pushPolicy;
		if (pushPolicy.kind === 'missing') {
			return {
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				success: false,
				error: `Refusing to push: repo "${options.repo.repoUrl}" has no trusted controller push policy. Configure the worker zone repoPushPolicies entry before controller push.`,
			};
		}
		const protectedBranchDescription = protectedBranchPolicyDescription({
			branchName,
			pushPolicy,
		});
		if (protectedBranchDescription !== undefined) {
			return {
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				success: false,
				error: `Refusing to push: "${branchName}" is a ${protectedBranchDescription}. Create an ${options.task.branchPrefix} branch first and move your commits to it.`,
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
			defaultBranch: pushPolicy.defaultBranch,
			repoUrl: options.branch.repoUrl,
			githubToken: options.githubToken,
			...(options.recordEvent ? { recordEvent: options.recordEvent } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		const previousRemoteBranchHead = await remoteBranchHead(
			options.repo.hostGitDir,
			branchName,
			options.signal,
		);
		const localHead = await gitStdout(
			options.repo.hostGitDir,
			['rev-parse', 'HEAD'],
			options.signal,
		);
		if (options.branch.expectedHead !== undefined && options.branch.expectedHead !== localHead) {
			return {
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				success: false,
				error: `Refusing to push: local HEAD '${localHead}' does not match expectedHead '${options.branch.expectedHead}'. Refresh task state before retrying.`,
				localHead,
			};
		}
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
			...(options.signal ? { signal: options.signal } : {}),
		});
		pushAttempts = pushResult.attempts;
		await fetchPushedBranchRef({
			gitDir: options.repo.hostGitDir,
			repoUrl: options.branch.repoUrl,
			branchName,
			githubToken: options.githubToken,
			...(options.recordEvent ? { recordEvent: options.recordEvent } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		const state = await buildBranchState({
			gitDir: options.repo.hostGitDir,
			branchName,
			defaultBranch: pushPolicy.defaultBranch,
			previousRemoteBranchHead,
			...(options.signal ? { signal: options.signal } : {}),
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
