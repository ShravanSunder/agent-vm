import type { RepoLocation } from '../../shared/repo-location.js';
import type { ToolDefinition } from '../../work-executor/executor-interface.js';
import { currentBranch, currentHead, selectRepo } from './controller-tool-support.js';
import {
	WorkerControlRpcCommandError,
	type WorkerControlControllerToolsClient,
} from './worker-control-rpc-client.js';

export interface CreateGitPushToolProps {
	readonly taskId: string;
	readonly repos: readonly RepoLocation[];
	readonly workerControlClient: WorkerControlControllerToolsClient;
}

export function createGitPushTool(props: CreateGitPushToolProps): ToolDefinition {
	return {
		name: 'git-push',
		description:
			'Push the current agent branch to origin via the controller. The VM has no GitHub token; only the controller can push. Refuses the repo default branch. Returns pushed commits and branch divergence.',
		inputSchema: {
			type: 'object',
			properties: {
				repoWorkPath: { type: 'string' },
				repoUrl: { type: 'string' },
			},
			additionalProperties: false,
		},
		async execute(params) {
			const selected = selectRepo(props.repos, params);
			if (!selected.repo) {
				return { type: 'push', success: false, artifact: selected.error ?? 'Repo not found.' };
			}
			const branchResult = await currentBranch(selected.repo.workPath);
			if (!branchResult.ok) {
				return {
					type: 'push',
					success: false,
					artifact: `Unable to read current git branch: ${branchResult.error}`,
				};
			}
			if (!branchResult.branch) {
				return { type: 'push', success: false, artifact: 'Refusing to push from detached HEAD.' };
			}
			if (branchResult.branch === selected.repo.baseBranch) {
				return {
					type: 'push',
					success: false,
					artifact: `Refusing to push: you are on the default branch "${selected.repo.baseBranch}". Create an agent/* branch first and move your commits to it.`,
				};
			}
			const headResult = await currentHead(selected.repo.workPath);
			if (!headResult.ok) {
				return {
					type: 'push',
					success: false,
					artifact: `Unable to read current git HEAD: ${headResult.error}`,
				};
			}

			try {
				const result = await props.workerControlClient.gitPush({
					branchName: branchResult.branch,
					expectedHead: headResult.head,
					repoUrl: selected.repo.repoUrl,
					taskId: props.taskId,
				});
				return { type: 'push', success: true, artifact: result };
			} catch (error) {
				if (error instanceof WorkerControlRpcCommandError) {
					return { type: 'push', success: false, artifact: error.message };
				}
				return {
					type: 'push',
					success: false,
					artifact: `Worker control git_push failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},
	};
}
