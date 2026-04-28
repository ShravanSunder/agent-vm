import { execa } from 'execa';

import type { ActiveWorkerTask } from './active-task-registry.js';
import { scrubGithubTokenFromOutput } from './git-auth-support.js';

const GIT_OPERATION_TIMEOUT_MS = 120_000;

export interface PullDefaultRequest {
	readonly repoUrl: string;
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
	readonly divergence?: {
		readonly aheadOfDefault: number;
		readonly behindDefault: number;
		readonly forkPoint: string;
	};
}

export class PullDefaultValidationError extends Error {}

function parseRepoFromUrl(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/, '');
	const urlPattern = /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)$/u;
	const match = urlPattern.exec(cleaned);
	if (match?.[1]) return match[1];
	if (/^[^\s/]+\/[^\s/]+$/u.test(cleaned)) return cleaned;
	throw new PullDefaultValidationError(`Invalid GitHub repository: ${repoUrl}`);
}

function buildPushUrl(repoUrl: string, githubToken: string): string {
	return `https://x-access-token:${githubToken}@github.com/${parseRepoFromUrl(repoUrl)}.git`;
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
	return (await git({ gitDir, args, reject: true })).stdout.trim();
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
	const result = await git({
		gitDir,
		args: ['log', range, '--format=%H%x09%s%x09%an%x09%aI'],
		reject: false,
	});
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

async function currentBranch(gitDir: string): Promise<string | null> {
	const result = await git({ gitDir, args: ['branch', '--show-current'], reject: false });
	if (result.exitCode !== 0) return null;
	const branch = result.stdout.trim();
	return branch.length > 0 ? branch : null;
}

export async function pullDefaultForTask(options: {
	readonly activeTask: ActiveWorkerTask;
	readonly repoUrl: string;
	readonly githubToken: string;
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
		const fetchResult = await git({
			gitDir: repo.hostGitDir,
			args: [
				'fetch',
				'--prune',
				buildPushUrl(options.repoUrl, options.githubToken),
				`${defaultBranch}:${remoteDefaultRef}`,
			],
			reject: false,
		});
		if (fetchResult.exitCode !== 0) {
			return {
				repoUrl: options.repoUrl,
				success: false,
				error: `Fetch failed: ${scrubGithubTokenFromOutput(`${fetchResult.stdout}\n${fetchResult.stderr}`).trim()}`,
			};
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

		await git({
			gitDir: repo.hostGitDir,
			args: ['update-ref', defaultRef, remoteDefaultRef],
			reject: true,
		});
		const localDefaultHead = await gitStdout(repo.hostGitDir, ['rev-parse', defaultRef]);
		const branch = await currentBranch(repo.hostGitDir);
		const forkPoint = await gitStdout(repo.hostGitDir, ['merge-base', 'HEAD', remoteDefaultRef]);
		const commitsSinceForkPoint = await commitSummaries(
			repo.hostGitDir,
			`${forkPoint}..${remoteDefaultRef}`,
		);

		return {
			repoUrl: options.repoUrl,
			success: true,
			defaultBranch,
			remoteDefaultHead,
			localDefaultHead,
			currentBranch: branch,
			fetchedCommits,
			commitsSinceForkPoint,
			divergence: {
				aheadOfDefault: await countRange(repo.hostGitDir, `${remoteDefaultRef}..HEAD`),
				behindDefault: await countRange(repo.hostGitDir, `HEAD..${remoteDefaultRef}`),
				forkPoint,
			},
		};
	} catch (error) {
		return {
			repoUrl: options.repoUrl,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
