import type { RepoLocation } from '../../shared/repo-location.js';
import type { ToolDefinition } from '../../work-executor/executor-interface.js';
import {
	isControllerToolFailure,
	postControllerJson,
	selectRepo,
} from './controller-tool-support.js';

const CONTROLLER_TOOL_TIMEOUT_MS = 120_000;

export interface CreateGitPullDefaultToolProps {
	readonly controllerBaseUrl: string;
	readonly zoneId: string;
	readonly taskId: string;
	readonly repos: readonly RepoLocation[];
}

export function createGitPullDefaultTool(props: CreateGitPullDefaultToolProps): ToolDefinition {
	return {
		name: 'git-pull-default',
		description:
			'Ask the controller to fetch origin/default and fast-forward the local default branch ref. Does not modify your current branch. Returns commits added to default and divergence vs your current branch.',
		inputSchema: {
			type: 'object',
			properties: {
				repoWorkspacePath: { type: 'string' },
				repoUrl: { type: 'string' },
			},
			additionalProperties: false,
		},
		async execute(params) {
			const selected = selectRepo(props.repos, params);
			if (!selected.repo) {
				return {
					type: 'pull-default',
					success: false,
					artifact: selected.error ?? 'Repo not found.',
				};
			}

			const result = await postControllerJson({
				url: `${props.controllerBaseUrl}/zones/${props.zoneId}/tasks/${props.taskId}/pull-default`,
				timeoutMs: CONTROLLER_TOOL_TIMEOUT_MS,
				body: { repoUrl: selected.repo.repoUrl },
			});
			if (isControllerToolFailure(result)) {
				return { type: 'pull-default', success: false, artifact: result.artifact };
			}
			return { type: 'pull-default', success: true, artifact: result };
		},
	};
}
