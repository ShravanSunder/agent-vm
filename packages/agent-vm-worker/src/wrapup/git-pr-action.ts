import { z } from 'zod';

import { configureGit, createBranch, stageAndCommit } from '../git/git-operations.js';
import type { RepoLocation } from '../shared/repo-location.js';
import type { ToolDefinition } from '../work-executor/executor-interface.js';
import type { WrapupToolOutput } from './wrapup-types.js';

const pushBranchesResponseSchema = z.object({
	results: z
		.array(
			z.object({
				success: z.boolean().optional(),
				prUrl: z.string().url().optional(),
				error: z.string().optional(),
			}),
		)
		.optional(),
});

export interface GitPrActionConfig {
	readonly branchPrefix: string;
	readonly commitCoAuthor: string;
	readonly controllerBaseUrl: string;
	readonly taskId: string;
	readonly taskPrompt: string;
	readonly plan: string | null;
	readonly repos: readonly RepoLocation[];
	readonly zoneId: string;
}

function selectTargetRepo(
	config: GitPrActionConfig,
	params: Record<string, unknown>,
): RepoLocation | null {
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

async function requestControllerPush(
	config: GitPrActionConfig,
	input: {
		readonly repoUrl: string;
		readonly branchName: string;
		readonly title: string;
		readonly body: string;
	},
): Promise<string> {
	const response = await fetch(
		`${config.controllerBaseUrl}/zones/${config.zoneId}/tasks/${config.taskId}/push-branches`,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				branches: [
					{
						repoUrl: input.repoUrl,
						branchName: input.branchName,
						title: input.title,
						body: input.body,
					},
				],
			}),
		},
	);
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`controller push request failed with HTTP ${response.status}: ${responseBody}`);
	}

	const parsed = pushBranchesResponseSchema.parse(JSON.parse(responseBody) as unknown);
	const result = parsed.results?.[0];
	if (!result) {
		throw new Error('controller push request returned no results');
	}
	if (!result.success) {
		throw new Error(result.error ?? 'controller push request failed');
	}
	if (!result.prUrl) {
		throw new Error('controller push request succeeded without a prUrl');
	}
	return result.prUrl;
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
		execute: async (params: Record<string, unknown>): Promise<WrapupToolOutput> => {
			try {
				const targetRepo = selectTargetRepo(config, params);
				if (!targetRepo) {
					return {
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

				const prUrl = await requestControllerPush(config, {
					repoUrl: targetRepo.repoUrl,
					branchName,
					title,
					body,
				});

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
