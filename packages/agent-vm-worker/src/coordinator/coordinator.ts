import { writeStderr } from '../shared/stderr.js';
import { createInitialState, hydrateTaskStates, isTerminal, type TaskState } from '../state/task-state.js';
import { buildTaskConfig, createTaskEventRecorder, sanitizeErrorMessage } from './coordinator-helpers.js';
import type { Coordinator, CoordinatorDeps, CreateTaskInput } from './coordinator-types.js';
import { runTask } from './task-runner.js';

export type { Coordinator, CreateTaskInput } from './coordinator-types.js';

async function handleRunTaskEscape(
	taskId: string,
	error: unknown,
	tasks: Map<string, TaskState>,
	eventRecorder: ReturnType<typeof createTaskEventRecorder>,
	finishActiveTask: (taskId: string) => void,
): Promise<void> {
	const reason = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
	writeStderr(`[coordinator] Unhandled runTask error for ${taskId}: ${reason}`);
	try {
		await eventRecorder.recordTaskFailure(taskId, reason);
	} catch (recordError) {
		const message = recordError instanceof Error ? recordError.message : String(recordError);
		writeStderr(`[coordinator] Failed to persist escaped task failure for ${taskId}: ${message}`);
		const current = tasks.get(taskId);
		if (current && !isTerminal(current)) {
			tasks.set(taskId, { ...current, status: 'failed', updatedAt: new Date().toISOString() });
		}
	} finally {
		finishActiveTask(taskId);
	}
}

export async function createCoordinator(deps: CoordinatorDeps): Promise<Coordinator> {
	const workspaceDir = deps.workspaceDir ?? '/workspace';
	const tasks = await hydrateTaskStates(deps.config.stateDir);
	const closedTaskIds = new Set<string>();
	const eventRecorder = createTaskEventRecorder(deps.config.stateDir, tasks, closedTaskIds);
	let activeTaskId: string | null = null;

	function finishActiveTask(taskId: string): void {
		if (activeTaskId === taskId) {
			activeTaskId = null;
		}
	}

	return {
		async submitTask(input: CreateTaskInput): Promise<{ taskId: string; status: 'accepted' }> {
			if (activeTaskId !== null) {
				throw new Error(`Another task is already active: ${activeTaskId}`);
			}

			const taskId = input.taskId;
			const taskConfig = buildTaskConfig(input, deps.config);
			tasks.set(taskId, createInitialState(taskId, taskConfig));
			await eventRecorder.emit(taskId, {
				event: 'task-accepted',
				taskId,
				config: taskConfig,
			});

			activeTaskId = taskId;
			void runTask(taskId, deps, workspaceDir, tasks, eventRecorder, () =>
				finishActiveTask(taskId),
			).catch(async (error) => {
				await handleRunTaskEscape(taskId, error, tasks, eventRecorder, finishActiveTask);
			});

			return { taskId, status: 'accepted' };
		},

		getActiveTaskId(): string | null {
			return activeTaskId;
		},

		getTaskState(taskId: string): TaskState | undefined {
			return tasks.get(taskId);
		},

		async closeTask(taskId: string): Promise<{ status: 'closed' }> {
			const state = tasks.get(taskId);
			if (!state) {
				throw new Error(`Task not found: ${taskId}`);
			}
			if (isTerminal(state)) {
				throw new Error(`Task ${taskId} is terminal: ${state.status}`);
			}

			closedTaskIds.add(taskId);
			await eventRecorder.emit(taskId, { event: 'task-closed' });
			finishActiveTask(taskId);
			return { status: 'closed' };
		},
	};
}
