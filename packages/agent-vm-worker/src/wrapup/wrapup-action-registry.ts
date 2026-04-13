import type { WorkerConfig } from '../config/worker-config.js';
import type { ToolDefinition } from '../work-executor/executor-interface.js';
import { createGitPrToolDefinition, type GitPrActionConfig } from './git-pr-action.js';
import { createSlackToolDefinition } from './slack-action.js';
import type { WrapupActionConfig, WrapupActionResult } from './wrapup-types.js';

export interface WrapupToolRegistryInput {
	readonly config: WorkerConfig;
	readonly taskId: string;
	readonly taskPrompt: string;
	readonly plan: string | null;
	readonly repos: readonly {
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly workspacePath: string;
	}[];
}

export interface WrapupToolRegistryResult {
	readonly tools: readonly ToolDefinition[];
	readonly getResults: () => readonly WrapupActionResult[];
}

function wrapToolWithResultCollector(
	tool: ToolDefinition,
	actionKey: string,
	actionType: string,
	results: WrapupActionResult[],
): ToolDefinition {
	return {
		...tool,
		execute: async (params: Record<string, unknown>): Promise<unknown> => {
			const result = (await tool.execute(params)) as Omit<WrapupActionResult, 'key' | 'type'> &
				Partial<Pick<WrapupActionResult, 'key' | 'type'>>;
			results.push({
				key: result.key ?? actionKey,
				type: result.type ?? actionType,
				success: result.success,
				...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
			});
			return result;
		},
	};
}

export function buildWrapupTools(input: WrapupToolRegistryInput): WrapupToolRegistryResult {
	const tools: ToolDefinition[] = [];
	const results: WrapupActionResult[] = [];

	for (const [index, action] of input.config.wrapupActions.entries()) {
		const actionKey = `${action.type}:${index}`;
		switch (action.type) {
			case 'git-pr': {
				const gitConfig: GitPrActionConfig = {
					branchPrefix: input.config.branchPrefix,
					commitCoAuthor: input.config.commitCoAuthor,
					taskId: input.taskId,
					taskPrompt: input.taskPrompt,
					plan: input.plan,
					repos: input.repos.map((repo) => ({
						repoUrl: repo.repoUrl,
						baseBranch: repo.baseBranch,
						workspacePath: repo.workspacePath,
					})),
				};
				tools.push(
					wrapToolWithResultCollector(
						createGitPrToolDefinition(gitConfig),
						actionKey,
						action.type,
						results,
					),
				);
				break;
			}
			case 'slack-post':
				tools.push(
					wrapToolWithResultCollector(
						createSlackToolDefinition({
							webhookUrl: action.webhookUrl,
							...(action.channel ? { channel: action.channel } : {}),
						}),
						actionKey,
						action.type,
						results,
					),
				);
				break;
		}
	}

	return {
		tools,
		getResults: () => [...results],
	};
}

export function getWrapupActionConfigs(config: WorkerConfig): readonly WrapupActionConfig[] {
	return config.wrapupActions.map((action, index) => ({
		key: `${action.type}:${index}`,
		type: action.type,
		required: 'required' in action ? (action.required ?? false) : false,
	}));
}
