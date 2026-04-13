import type { TaskState } from '../state/task-state.js';

export interface CreateTaskInput {
	readonly taskId: string;
	readonly prompt: string;
	readonly repo?: {
		readonly repoUrl: string;
		readonly baseBranch: string;
		readonly workspacePath: string;
	} | null;
	readonly context?: Record<string, unknown>;
}

export interface Coordinator {
	submitTask(input: CreateTaskInput): Promise<{ taskId: string; status: 'accepted' }>;
	getActiveTaskId(): string | null;
	getTaskState(taskId: string): TaskState | undefined;
	closeTask(taskId: string): Promise<{ status: 'closed' }>;
}
