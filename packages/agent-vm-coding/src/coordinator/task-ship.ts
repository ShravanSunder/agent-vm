import { createPullRequest, pushBranch, stageAndCommit } from '../git/git-operations.js';
import type { TaskState } from '../state/task-state.js';

export interface ShipTaskProps {
	readonly branchName: string;
	readonly commitCoAuthor: string;
	readonly workspaceDir: string;
	readonly taskState: TaskState;
}

export async function shipTask(props: ShipTaskProps): Promise<string> {
	await stageAndCommit({
		message: `feat: ${props.taskState.config.prompt.slice(0, 72)}`,
		coAuthor: props.commitCoAuthor,
		cwd: props.workspaceDir,
	});

	await pushBranch({
		repo: props.taskState.config.repoUrl,
		branchName: props.branchName,
		cwd: props.workspaceDir,
	});

	return createPullRequest(
		{
			repo: props.taskState.config.repoUrl,
			title: `feat: ${props.taskState.config.prompt.slice(0, 72)}`,
			body: props.taskState.plan?.slice(0, 2000) ?? '',
			baseBranch: props.taskState.config.baseBranch,
			headBranch: props.branchName,
		},
		props.workspaceDir,
	);
}
