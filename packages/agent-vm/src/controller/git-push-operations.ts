import { execa } from 'execa';

import type { ActiveWorkerTask } from './active-task-registry.js';

export interface PushBranchRequest {
	readonly repoUrl: string;
	readonly branchName: string;
	readonly title: string;
	readonly body: string;
}

export interface PushBranchResult {
	readonly repoUrl: string;
	readonly branchName: string;
	readonly success: boolean;
	readonly prUrl?: string;
	readonly error?: string;
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

async function pushBranch(options: {
	readonly repoUrl: string;
	readonly branchName: string;
	readonly cwd: string;
	readonly githubToken: string;
}): Promise<void> {
	const result = await execa(
		'git',
		[
			'push',
			buildPushUrl(options.repoUrl, options.githubToken),
			sanitizeBranchName(options.branchName),
		],
		{
			cwd: options.cwd,
			reject: false,
		},
	);

	if ((result.exitCode ?? -1) !== 0) {
		const errorDetail = `${result.stdout}\n${result.stderr}`
			.replace(/https:\/\/x-access-token:[^@]*@/gu, 'https://x-access-token:***@')
			.trim();
		writePushFlowLog(
			`git push failed for ${options.repoUrl} ${sanitizeBranchName(options.branchName)}: ${errorDetail}`,
		);
		throw new Error(`git push failed\n${errorDetail}`);
	}
}

async function createPullRequest(options: {
	readonly repoUrl: string;
	readonly title: string;
	readonly body: string;
	readonly baseBranch: string;
	readonly headBranch: string;
	readonly cwd: string;
	readonly githubToken: string;
}): Promise<string> {
	const result = await execa(
		'gh',
		[
			'pr',
			'create',
			'--repo',
			parseRepoFromUrl(options.repoUrl),
			'--title',
			options.title,
			'--body',
			options.body,
			'--base',
			options.baseBranch,
			'--head',
			sanitizeBranchName(options.headBranch),
		],
		{
			cwd: options.cwd,
			env: {
				...process.env,
				GITHUB_TOKEN: options.githubToken,
			},
			reject: false,
		},
	);

	if ((result.exitCode ?? -1) !== 0) {
		const errorDetail = `${result.stdout}\n${result.stderr}`
			.replace(/https:\/\/x-access-token:[^@]*@/gu, 'https://x-access-token:***@')
			.trim();
		writePushFlowLog(
			`gh pr create failed for ${options.repoUrl} ${sanitizeBranchName(options.headBranch)}: ${errorDetail}`,
		);
		throw new Error(`Failed to create pull request\n${errorDetail}`.trim());
	}
	const prUrl = result.stdout.trim().split('\n').pop() ?? '';
	if (prUrl.length === 0) {
		throw new Error('gh pr create succeeded without returning a PR URL');
	}
	return prUrl;
}

export async function pushBranchesForTask(options: {
	readonly activeTask: ActiveWorkerTask;
	readonly branches: readonly PushBranchRequest[];
	readonly githubToken: string;
}): Promise<{ readonly results: readonly PushBranchResult[] }> {
	for (const branch of options.branches) {
		if (!branch.branchName.startsWith(options.activeTask.branchPrefix)) {
			throw new PushBranchesValidationError(
				`Branch '${branch.branchName}' must start with '${options.activeTask.branchPrefix}'.`,
			);
		}
		const repo = options.activeTask.repos.find((candidate) => candidate.repoUrl === branch.repoUrl);
		if (!repo) {
			throw new PushBranchesValidationError(
				`Repo '${branch.repoUrl}' is not registered for active task '${options.activeTask.taskId}'.`,
			);
		}
	}

	const results: PushBranchResult[] = [];
	const validatedBranches = options.branches.map((branch) => {
		const repo = options.activeTask.repos.find((candidate) => candidate.repoUrl === branch.repoUrl);
		if (!repo) {
			throw new PushBranchesValidationError(
				`Repo '${branch.repoUrl}' is not registered for active task '${options.activeTask.taskId}'.`,
			);
		}
		return { branch, repo };
	});
	for (const { branch, repo } of validatedBranches) {
		try {
			// Host-side push/PR operations stay ordered so failures are attributed to the right repo.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await pushBranch({
				repoUrl: branch.repoUrl,
				branchName: branch.branchName,
				cwd: repo.hostWorkspacePath,
				githubToken: options.githubToken,
			});
			// oxlint-disable-next-line eslint/no-await-in-loop
			const prUrl = await createPullRequest({
				repoUrl: branch.repoUrl,
				title: branch.title,
				body: branch.body,
				baseBranch: repo.baseBranch,
				headBranch: branch.branchName,
				cwd: repo.hostWorkspacePath,
				githubToken: options.githubToken,
			});
			results.push({
				repoUrl: branch.repoUrl,
				branchName: branch.branchName,
				success: true,
				prUrl,
			});
		} catch (error) {
			results.push({
				repoUrl: branch.repoUrl,
				branchName: branch.branchName,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { results };
}
