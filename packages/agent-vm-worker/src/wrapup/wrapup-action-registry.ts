import type { WorkerConfig } from '../config/worker-config.js';
import type { RepoLocation } from '../shared/repo-location.js';
import { writeStderr } from '../shared/stderr.js';
import type { ToolDefinition } from '../work-executor/executor-interface.js';
import { createGitPrToolDefinition, type GitPrActionConfig } from './git-pr-action.js';
import { createSlackToolDefinition } from './slack-action.js';
import {
	wrapupToolOutputSchema,
	type WrapupActionConfig,
	type WrapupActionResult,
} from './wrapup-types.js';

export interface WrapupToolRegistryInput {
	readonly config: WorkerConfig;
	readonly controllerBaseUrl: string;
	readonly taskId: string;
	readonly taskPrompt: string;
	readonly plan: string | null;
	readonly repos: readonly RepoLocation[];
	readonly zoneId: string;
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
			try {
				const parseResult = wrapupToolOutputSchema.safeParse(await tool.execute(params));
				if (!parseResult.success) {
					const result: WrapupActionResult = {
						key: actionKey,
						type: actionType,
						success: false,
						artifact: `Invalid wrapup action result: ${parseResult.error.issues
							.map((issue) => issue.message)
							.join('; ')}`,
					};
					results.push(result);
					return result;
				}

				const result = parseResult.data;
				results.push({
					key: actionKey,
					type: actionType,
					success: result.success,
					...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
				});
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				writeStderr(
					`[wrapup-action-registry] Wrapup action ${actionKey} (${actionType}) threw: ${message}`,
				);
				const result: WrapupActionResult = {
					key: actionKey,
					type: actionType,
					success: false,
					artifact: message,
				};
				results.push(result);
				return result;
			}
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
					controllerBaseUrl: input.controllerBaseUrl,
					taskId: input.taskId,
					taskPrompt: input.taskPrompt,
					plan: input.plan,
					repos: input.repos.map((repo) => ({
						repoUrl: repo.repoUrl,
						baseBranch: repo.baseBranch,
						workspacePath: repo.workspacePath,
					})),
					zoneId: input.zoneId,
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
