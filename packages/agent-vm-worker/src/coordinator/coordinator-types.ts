import type { WorkerConfig } from '../config/worker-config.js';
import type { RepoLocation } from '../shared/repo-location.js';
import type { TaskState } from '../state/task-state.js';

export interface CreateTaskInput {
	readonly taskId: string;
	readonly prompt: string;
	readonly repos?: readonly RepoLocation[];
	readonly context?: Record<string, unknown>;
}

export interface CoordinatorDeps {
	readonly config: WorkerConfig;
	readonly workspaceDir?: string;
}

export interface Coordinator {
	submitTask(input: CreateTaskInput): Promise<{ taskId: string; status: 'accepted' }>;
	getActiveTaskId(): string | null;
	getTaskState(taskId: string): TaskState | undefined;
	closeTask(taskId: string): Promise<{ status: 'closed' }>;
}
