import {
	configureGit,
	createBranch,
	createPullRequest,
	pushBranch,
	stageAndCommit,
} from '../git/git-operations.js';
import type { ToolDefinition } from '../work-executor/executor-interface.js';
import type { WrapupActionResult } from './wrapup-types.js';

export interface GitPrActionConfig {
	readonly branchPrefix: string;
	readonly commitCoAuthor: string;
	readonly taskId: string;
	readonly taskPrompt: string;
	readonly plan: string | null;
	readonly repos: readonly {
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly workspacePath: string;
	}[];
}

function selectTargetRepo(
	config: GitPrActionConfig,
	params: Record<string, unknown>,
): {
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly workspacePath: string;
} | null {
	const requestedWorkspacePath =
		typeof params.repoWorkspacePath === 'string' ? params.repoWorkspacePath : null;
	const requestedRepoUrl = typeof params.repoUrl === 'string' ? params.repoUrl : null;

	if (requestedWorkspacePath) {
		return config.repos.find((repo) => repo.workspacePath === requestedWorkspacePath) ?? null;
	}
	if (requestedRepoUrl) {
		return config.repos.find((repo) => repo.repoUrl === requestedRepoUrl) ?? null;
	}
	return config.repos[0] ?? null;
}

export function createGitPrToolDefinition(config: GitPrActionConfig): ToolDefinition {
	return {
		name: 'git-pr',
		description:
			'Stage all changes, commit, push to a new branch, and create a pull request. Call this after all code changes are complete.',
		inputSchema: {
			type: 'object',
			properties: {
				title: {
					type: 'string',
					description: 'PR title (max 72 chars)',
				},
				body: {
					type: 'string',
					description: 'PR description (markdown)',
				},
				repoWorkspacePath: {
					type: 'string',
					description:
						'Optional workspace path of the repo to wrap up, required when multiple repos are present.',
				},
				repoUrl: {
					type: 'string',
					description:
						'Optional repo URL of the repo to wrap up, used if repoWorkspacePath is omitted.',
				},
			},
			required: ['title', 'body'],
		},
		execute: async (params: Record<string, unknown>): Promise<WrapupActionResult> => {
			try {
				const targetRepo = selectTargetRepo(config, params);
				if (!targetRepo) {
					return {
						key: '',
						type: 'git-pr',
						success: false,
						artifact: 'No repo configured - cannot create PR.',
					};
				}
				if (
					config.repos.length > 1 &&
					typeof params.repoWorkspacePath !== 'string' &&
					typeof params.repoUrl !== 'string'
				) {
					return {
						key: '',
						type: 'git-pr',
						success: false,
						artifact:
							'Multiple repos configured - provide repoWorkspacePath or repoUrl to choose which repo to wrap up.',
					};
				}

				const title =
					typeof params.title === 'string'
						? params.title
						: `feat: ${config.taskPrompt.slice(0, 72)}`;
				const body =
					typeof params.body === 'string' ? params.body : (config.plan?.slice(0, 2000) ?? '');
				const branchName = `${config.branchPrefix}${config.taskId}`;

				await configureGit(
					{
						userEmail: 'agent-vm-worker@agent-vm',
						userName: 'agent-vm-worker',
					},
					targetRepo.workspacePath,
				);
				await createBranch(branchName, targetRepo.workspacePath);
				await stageAndCommit({
					message: title,
					coAuthor: config.commitCoAuthor,
					cwd: targetRepo.workspacePath,
				});
				await pushBranch({
					repo: targetRepo.repoUrl,
					branchName,
					cwd: targetRepo.workspacePath,
				});

				const prUrl = await createPullRequest(
					{
						repo: targetRepo.repoUrl,
						title,
						body,
						baseBranch: targetRepo.baseBranch,
						headBranch: branchName,
					},
					targetRepo.workspacePath,
				);

				return {
					key: '',
					type: 'git-pr',
					artifact: prUrl,
					success: true,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const sanitized = message.replace(
					/https:\/\/x-access-token:[^@]*@/g,
					'https://x-access-token:***@',
				);
				return {
					key: '',
					type: 'git-pr',
					artifact: sanitized,
					success: false,
				};
			}
		},
	};
}
