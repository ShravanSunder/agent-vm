import path from 'node:path';

import { resolveManagedAgentGitDirectoryRoot } from '../../gateway/managed-agent-root-storage.js';

export const TOOL_VM_WORKSPACE_GIT_DIRECTORY = '/gitdirs/workspace.git';

export interface WorkspaceGitPaths {
	readonly hostGitDirectory: string;
	readonly hostGitDirectoryRoot: string;
}

export function resolveWorkspaceGitPaths(options: {
	readonly agentId: string;
	readonly runtimeDir: string;
	readonly zoneId: string;
}): WorkspaceGitPaths {
	const hostGitDirectoryRoot = resolveManagedAgentGitDirectoryRoot(options);
	return {
		hostGitDirectory: path.join(hostGitDirectoryRoot, 'workspace.git'),
		hostGitDirectoryRoot,
	};
}
