import type { RepoLocation } from '../../shared/repo-location.js';
import type { ToolDefinition } from '../../work-executor/executor-interface.js';
import {
	currentBranch,
	isControllerToolFailure,
	postControllerJson,
	selectRepo,
} from './controller-tool-support.js';

const CONTROLLER_TOOL_TIMEOUT_MS = 120_000;

export interface CreateGitPushToolProps {
	readonly controllerBaseUrl: string;
	readonly zoneId: string;
	readonly taskId: string;
	readonly repos: readonly RepoLocation[];
}

export function createGitPushTool(props: CreateGitPushToolProps): ToolDefinition {
	return {
		name: 'git-push',
		description:
			'Push the current agent branch to origin via the controller. The VM has no GitHub token; only the controller can push. Refuses the repo default branch. Returns pushed commits and branch divergence.',
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
				return { type: 'push', success: false, artifact: selected.error ?? 'Repo not found.' };
			}
			const branchName = await currentBranch(selected.repo.workspacePath);
			if (!branchName) {
				return { type: 'push', success: false, artifact: 'Refusing to push from detached HEAD.' };
			}
			if (branchName === selected.repo.baseBranch) {
				return {
					type: 'push',
					success: false,
					artifact: `Refusing to push: you are on the default branch "${selected.repo.baseBranch}". Create an agent/* branch first and move your commits to it.`,
				};
			}

			const result = await postControllerJson({
				url: `${props.controllerBaseUrl}/zones/${props.zoneId}/tasks/${props.taskId}/push-branches`,
				timeoutMs: CONTROLLER_TOOL_TIMEOUT_MS,
				body: {
					branches: [{ repoUrl: selected.repo.repoUrl, branchName }],
				},
			});
			if (isControllerToolFailure(result)) {
				return { type: 'push', success: false, artifact: result.artifact };
			}
			return { type: 'push', success: true, artifact: result };
		},
	};
}
