import { execa } from 'execa';

import type { ActiveWorkerTask } from './active-task-registry.js';
import { scrubGithubTokenFromOutput } from './git-auth-support.js';

const GIT_OPERATION_TIMEOUT_MS = 120_000;

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

function writePushFlowLog(message: string): void {
	process.stderr.write(`[git-push-operations] ${message}\n`);
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

async function gitStdout(gitDir: string, args: readonly string[]): Promise<string> {
	return (await git({ args, gitDir, reject: true })).stdout.trim();
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
	const result = await git({ gitDir, args: ['log', range, `--format=${format}`], reject: false });
	if (result.exitCode !== 0) return [];
	return parseCommitSummaries(result.stdout);
}

async function refExists(gitDir: string, ref: string): Promise<boolean> {
	return (
		(await git({ gitDir, args: ['rev-parse', '--verify', '--quiet', ref], reject: false }))
			.exitCode === 0
	);
}

async function countRange(gitDir: string, range: string): Promise<number> {
	const result = await git({ gitDir, args: ['rev-list', '--count', range], reject: false });
	if (result.exitCode !== 0) return 0;
	return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function fetchRemoteRefs(options: {
	readonly gitDir: string;
	readonly defaultBranch: string;
	readonly repoUrl: string;
	readonly githubToken: string;
}): Promise<void> {
	const pushUrl = buildPushUrl(options.repoUrl, options.githubToken);
	const result = await git({
		gitDir: options.gitDir,
		args: [
			'fetch',
			'--prune',
			pushUrl,
			`${options.defaultBranch}:refs/remotes/origin/${options.defaultBranch}`,
		],
		reject: false,
	});
	if (result.exitCode !== 0) {
		const detail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
		throw new Error(`git fetch failed\n${detail}`);
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
}): Promise<void> {
	const result = await git({
		gitDir: options.gitDir,
		args: [
			'push',
			buildPushUrl(options.repoUrl, options.githubToken),
			`${sanitizeBranchName(options.branchName)}:refs/heads/${sanitizeBranchName(options.branchName)}`,
		],
		reject: false,
	});

	if (result.exitCode !== 0) {
		const errorDetail = scrubGithubTokenFromOutput(`${result.stdout}\n${result.stderr}`).trim();
		writePushFlowLog(
			`git push failed for ${options.repoUrl} ${sanitizeBranchName(options.branchName)}: ${errorDetail}`,
		);
		throw new Error(`git push failed\n${errorDetail}`);
	}
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
}): Promise<{ readonly results: readonly PushBranchResult[] }> {
	const requestedRepoUrls = new Set<string>();
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
		const repo = options.activeTask.repos.find((candidate) => candidate.repoUrl === branch.repoUrl);
		if (!repo) {
			throw new PushBranchesValidationError(
				`Repo '${branch.repoUrl}' is not registered for active task '${options.activeTask.taskId}'.`,
			);
		}
	}

	const results = await Promise.all(
		options.branches.map(async (branch) => {
			const repo = options.activeTask.repos.find(
				(candidate) => candidate.repoUrl === branch.repoUrl,
			);
			if (!repo) {
				throw new PushBranchesValidationError(
					`Repo '${branch.repoUrl}' is not registered for active task '${options.activeTask.taskId}'.`,
				);
			}
			return await pushOneBranchForTask({
				branch,
				githubToken: options.githubToken,
				repo,
				task: options.activeTask,
			});
		}),
	);

	return { results };
}

async function pushOneBranchForTask(options: {
	readonly branch: PushBranchRequest;
	readonly githubToken: string;
	readonly repo: ActiveWorkerTask['repos'][number];
	readonly task: ActiveWorkerTask;
}): Promise<PushBranchResult> {
	const branchName = sanitizeBranchName(options.branch.branchName);
	try {
		if (branchName === options.repo.baseBranch) {
			return {
				repoUrl: options.branch.repoUrl,
				branch: branchName,
				success: false,
				error: `Refusing to push: you are on the default branch "${options.repo.baseBranch}". Create an ${options.task.branchPrefix} branch first and move your commits to it.`,
			};
		}

		await fetchRemoteRefs({
			gitDir: options.repo.hostGitDir,
			defaultBranch: options.repo.baseBranch,
			repoUrl: options.branch.repoUrl,
			githubToken: options.githubToken,
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

		await pushBranch({
			repoUrl: options.branch.repoUrl,
			branchName,
			gitDir: options.repo.hostGitDir,
			githubToken: options.githubToken,
		});
		await git({
			gitDir: options.repo.hostGitDir,
			args: [
				'fetch',
				'--prune',
				buildPushUrl(options.branch.repoUrl, options.githubToken),
				`${branchName}:refs/remotes/origin/${branchName}`,
			],
			reject: false,
		});
		const state = await buildBranchState({
			gitDir: options.repo.hostGitDir,
			branchName,
			defaultBranch: options.repo.baseBranch,
			previousRemoteBranchHead,
		});
		return {
			repoUrl: options.branch.repoUrl,
			branch: branchName,
			success: true,
			...state,
		};
	} catch (error) {
		return {
			repoUrl: options.branch.repoUrl,
			branch: branchName,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
