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
	readonly workspaceDir: string;
	readonly taskId: string;
	readonly taskPrompt: string;
	readonly plan: string | null;
	readonly repo: {
		readonly repoUrl: string;
		readonly baseBranch: string;
	} | null;
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
			},
			required: ['title', 'body'],
		},
		execute: async (params: Record<string, unknown>): Promise<WrapupActionResult> => {
			try {
				if (!config.repo) {
					return {
						type: 'git-pr',
						success: false,
						artifact: 'No repo configured - cannot create PR.',
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
					config.workspaceDir,
				);
				await createBranch(branchName, config.workspaceDir);
				await stageAndCommit({
					message: title,
					coAuthor: config.commitCoAuthor,
					cwd: config.workspaceDir,
				});
				await pushBranch({
					repo: config.repo.repoUrl,
					branchName,
					cwd: config.workspaceDir,
				});

				const prUrl = await createPullRequest(
					{
						repo: config.repo.repoUrl,
						title,
						body,
						baseBranch: config.repo.baseBranch,
						headBranch: branchName,
					},
					config.workspaceDir,
				);

				return {
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
					type: 'git-pr',
					artifact: sanitized,
					success: false,
				};
			}
		},
	};
}
