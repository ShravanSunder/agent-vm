/* oxlint-disable eslint/no-await-in-loop -- git setup commands intentionally run in order */
import { execa } from 'execa';

export interface GitConfigOptions {
	readonly userEmail: string;
	readonly userName: string;
}

export interface CommitOptions {
	readonly message: string;
	readonly coAuthor: string;
	readonly cwd: string;
}

export interface PushOptions {
	readonly repo: string;
	readonly branchName: string;
	readonly cwd: string;
}

export interface PullRequestOptions {
	readonly repo: string;
	readonly title: string;
	readonly body: string;
	readonly baseBranch: string;
	readonly headBranch: string;
}

interface GitResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

async function execGitShell(command: string, cwd: string): Promise<GitResult> {
	const result = await execa(command, {
		shell: true,
		cwd,
		reject: false,
	});

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode ?? -1,
	};
}

async function execGitArgs(bin: string, args: readonly string[], cwd: string): Promise<GitResult> {
	const result = await execa(bin, args, {
		cwd,
		reject: false,
	});

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode ?? -1,
	};
}

export function sanitizeBranchName(name: string): string {
	return name.replace(/[^a-zA-Z0-9\-_./]/g, '-');
}

export async function configureGit(options: GitConfigOptions, cwd: string): Promise<void> {
	const commands: readonly (readonly [string, ...string[]])[] = [
		['git', 'config', '--global', '--add', 'safe.directory', cwd],
		['git', 'config', 'http.version', 'HTTP/1.1'],
		['git', 'config', 'user.email', options.userEmail],
		['git', 'config', 'user.name', options.userName],
	];

	// These config writes must remain ordered so later failures identify the exact command.
	// oxlint-disable-next-line eslint/no-await-in-loop
	for (const [bin, ...args] of commands) {
		const result = await execGitArgs(bin, args, cwd);
		if (result.exitCode !== 0) {
			throw new Error(
				`Git config failed: ${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`.trim(),
			);
		}
	}
}

export async function createBranch(branchName: string, cwd: string): Promise<void> {
	const safeBranch = sanitizeBranchName(branchName);
	const result = await execGitArgs('git', ['checkout', '-b', safeBranch], cwd);

	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to create branch: ${safeBranch}\n${result.stdout}\n${result.stderr}`.trim(),
		);
	}
}

export async function stageAndCommit(options: CommitOptions): Promise<void> {
	const addResult = await execGitShell('git add -A', options.cwd);
	if (addResult.exitCode !== 0) {
		throw new Error(`Failed to stage files\n${addResult.stdout}\n${addResult.stderr}`.trim());
	}

	const commitMessage = buildCommitMessage(options.message, options.coAuthor);
	const commitResult = await execGitArgs('git', ['commit', '-m', commitMessage], options.cwd);

	if (commitResult.exitCode !== 0) {
		if (commitResult.stdout.includes('nothing to commit')) {
			return;
		}
		throw new Error(
			`Failed to create commit\n${commitResult.stdout}\n${commitResult.stderr}`.trim(),
		);
	}
}

export async function getDiffStat(cwd: string): Promise<string> {
	const result = await execGitShell('git diff --stat', cwd);
	return result.stdout;
}

export async function getDiff(cwd: string): Promise<string> {
	const result = await execGitShell('git diff', cwd);
	return result.stdout;
}

export function parseRepoFromUrl(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/, '');
	const urlPattern = /(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)$/;
	const match = urlPattern.exec(cleaned);

	if (match?.[1]) {
		return match[1];
	}
	if (/^[^\s/]+\/[^\s/]+$/.test(cleaned)) {
		return cleaned;
	}

	throw new Error(`Invalid GitHub repository: ${repoUrl}`);
}

export function buildCommitMessage(message: string, coAuthor: string): string {
	return `${message}\n\nCo-Authored-By: ${coAuthor}`;
}
