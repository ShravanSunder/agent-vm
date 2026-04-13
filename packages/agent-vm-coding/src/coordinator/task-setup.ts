import type { RepoContext } from '../context/gather-context.js';
import { gatherContext } from '../context/gather-context.js';
import { configureGit, createBranch } from '../git/git-operations.js';

export function gatherTaskContext(workspaceDir: string): RepoContext {
	return gatherContext(workspaceDir);
}

export async function setupGitForTask(branchName: string, workspaceDir: string): Promise<void> {
	await configureGit(
		{
			userEmail: 'agent-vm-coding@agent-vm',
			userName: 'agent-vm-coding',
		},
		workspaceDir,
	);
	await createBranch(branchName, workspaceDir);
}
