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
	readonly repo: {
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly workspacePath: string;
	} | null;
}

export interface WrapupToolRegistryResult {
	readonly tools: readonly ToolDefinition[];
	readonly getResults: () => readonly WrapupActionResult[];
}

function wrapToolWithResultCollector(
	tool: ToolDefinition,
	results: WrapupActionResult[],
): ToolDefinition {
	return {
		...tool,
		execute: async (params: Record<string, unknown>): Promise<unknown> => {
			const result = (await tool.execute(params)) as WrapupActionResult;
			results.push(result);
			return result;
		},
	};
}

export function buildWrapupTools(input: WrapupToolRegistryInput): WrapupToolRegistryResult {
	const tools: ToolDefinition[] = [];
	const results: WrapupActionResult[] = [];

	for (const action of input.config.wrapupActions) {
		switch (action.type) {
			case 'git-pr': {
				const gitConfig: GitPrActionConfig = {
					branchPrefix: input.config.branchPrefix,
					commitCoAuthor: input.config.commitCoAuthor,
					workspaceDir: input.repo?.workspacePath ?? '/workspace',
					taskId: input.taskId,
					taskPrompt: input.taskPrompt,
					plan: input.plan,
					repo: input.repo
						? {
								repoUrl: input.repo.repoUrl,
								baseBranch: input.repo.baseBranch,
							}
						: null,
				};
				tools.push(wrapToolWithResultCollector(createGitPrToolDefinition(gitConfig), results));
				break;
			}
			case 'slack-post':
				tools.push(
					wrapToolWithResultCollector(
						createSlackToolDefinition({
							webhookUrl: action.webhookUrl,
							...(action.channel ? { channel: action.channel } : {}),
						}),
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
	return config.wrapupActions.map((action) => ({
		type: action.type,
		required: 'required' in action ? (action.required ?? false) : false,
	}));
}
