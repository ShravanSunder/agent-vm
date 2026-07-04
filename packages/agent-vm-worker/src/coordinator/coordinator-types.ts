import type { WorkerConfig } from '../config/worker-config.js';
import type { WorkerControlService } from '../control-session/worker-control-service.js';
import type { RepoLocation } from '../shared/repo-location.js';
import type { TaskStatus } from '../state/task-event-types.js';
import type { TaskState } from '../state/task-state.js';

export interface CreateTaskInput {
	readonly taskId: string;
	readonly prompt: string;
	readonly repos?: readonly RepoLocation[];
	readonly context?: Record<string, unknown>;
}

export interface CoordinatorDeps {
	readonly config: WorkerConfig;
	readonly workDir?: string;
	readonly workerControlService?: Pick<
		WorkerControlService,
		'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
	>;
}

export interface Coordinator {
	submitTask(input: CreateTaskInput): Promise<{ taskId: string; status: 'accepted' }>;
	getActiveTaskId(): string | null;
	getTaskState(taskId: string): TaskState | undefined;
	waitForTaskStatus(
		taskId: string,
		status: TaskStatus,
		options?: WaitForTaskStatusOptions,
	): Promise<TaskState>;
	closeTask(taskId: string): Promise<{ status: 'closed' }>;
}

export interface WaitForTaskStatusOptions {
	readonly timeoutMs?: number;
}
