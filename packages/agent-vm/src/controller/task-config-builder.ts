import type { TaskConfig, WorkerConfig } from '@agent-vm/agent-vm-worker';

import type { WorkerTaskControllerRequest } from '../config/resource-contracts/index.js';

export interface BuildTaskConfigFromPreparedInput {
	readonly effectiveConfig: WorkerConfig;
	readonly input: WorkerTaskControllerRequest;
	readonly repos: readonly {
		readonly baseBranch: string;
		readonly repoUrl: string;
		readonly workspacePath: string;
	}[];
	readonly taskId: string;
}

export function buildTaskConfigFromPreparedInput(
	prepared: BuildTaskConfigFromPreparedInput,
): TaskConfig {
	return {
		taskId: prepared.taskId,
		prompt: prepared.input.prompt,
		repos: prepared.repos.map((repo) => ({
			repoUrl: repo.repoUrl,
			baseBranch: repo.baseBranch,
			workspacePath: repo.workspacePath,
		})),
		context: prepared.input.context,
		effectiveConfig: prepared.effectiveConfig,
	};
}
