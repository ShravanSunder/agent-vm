import { writeStderr } from '../shared/stderr.js';
import type { TaskEvent, TaskStatus } from '../state/task-event-types.js';
import {
	createInitialState,
	hydrateTaskStates,
	isTerminal,
	type TaskState,
} from '../state/task-state.js';
import {
	buildTaskConfig,
	createTaskEventRecorder,
	formatTaskFailureReason,
	type TaskEventRecorder,
} from './coordinator-helpers.js';
import type {
	Coordinator,
	CoordinatorDeps,
	CreateTaskInput,
	WaitForTaskStatusOptions,
} from './coordinator-types.js';
import { runTask } from './task-runner.js';

export type { Coordinator, CreateTaskInput } from './coordinator-types.js';

async function handleRunTaskEscape(
	taskId: string,
	error: unknown,
	tasks: Map<string, TaskState>,
	eventRecorder: TaskEventRecorder,
	finishActiveTask: (taskId: string) => void,
	notifyTaskStateChanged: (taskId: string) => void,
): Promise<void> {
	const reason = formatTaskFailureReason(error);
	writeStderr(`[coordinator] Unhandled runTask error for ${taskId}: ${reason}`);
	try {
		await eventRecorder.recordTaskFailure(taskId, reason);
	} catch (recordError) {
		const message = recordError instanceof Error ? recordError.message : String(recordError);
		writeStderr(`[coordinator] Failed to persist escaped task failure for ${taskId}: ${message}`);
		const current = tasks.get(taskId);
		if (current && !isTerminal(current)) {
			tasks.set(taskId, { ...current, status: 'failed', updatedAt: new Date().toISOString() });
			notifyTaskStateChanged(taskId);
		}
	} finally {
		finishActiveTask(taskId);
	}
}

interface TaskStatusWaiter {
	readonly reject: (error: Error) => void;
	readonly resolve: (state: TaskState) => void;
	readonly status: TaskStatus;
	readonly timeout: ReturnType<typeof setTimeout>;
}

const defaultTaskStatusWaitTimeoutMs = 5_000;

export async function createCoordinator(deps: CoordinatorDeps): Promise<Coordinator> {
	const workDir = deps.workDir ?? '/work';
	const tasks = await hydrateTaskStates(deps.config.stateDir);
	const closedTaskIds = new Set<string>();
	const taskStatusWaiters = new Map<string, TaskStatusWaiter[]>();
	const baseEventRecorder = createTaskEventRecorder(deps.config.stateDir, tasks, closedTaskIds);
	let activeTaskId: string | null = null;

	function finishActiveTask(taskId: string): void {
		if (activeTaskId === taskId) {
			activeTaskId = null;
		}
	}

	function notifyTaskStateChanged(taskId: string): void {
		const state = tasks.get(taskId);
		if (state === undefined) {
			return;
		}
		const waiters = taskStatusWaiters.get(taskId);
		if (waiters === undefined) {
			return;
		}
		const remainingWaiters: TaskStatusWaiter[] = [];
		for (const waiter of waiters) {
			if (state.status === waiter.status) {
				clearTimeout(waiter.timeout);
				waiter.resolve(state);
			} else if (isTerminal(state)) {
				clearTimeout(waiter.timeout);
				waiter.reject(
					new Error(
						`Task ${taskId} reached terminal status ${state.status} before ${waiter.status}.`,
					),
				);
			} else {
				remainingWaiters.push(waiter);
			}
		}
		if (remainingWaiters.length === 0) {
			taskStatusWaiters.delete(taskId);
		} else {
			taskStatusWaiters.set(taskId, remainingWaiters);
		}
	}

	function removeTaskStatusWaiter(taskId: string, targetWaiter: TaskStatusWaiter): void {
		const waiters = taskStatusWaiters.get(taskId);
		if (waiters === undefined) {
			return;
		}
		const remainingWaiters = waiters.filter((waiter) => waiter !== targetWaiter);
		if (remainingWaiters.length === 0) {
			taskStatusWaiters.delete(taskId);
		} else {
			taskStatusWaiters.set(taskId, remainingWaiters);
		}
	}

	const eventRecorder = {
		async emit(taskId: string, event: TaskEvent): Promise<void> {
			await baseEventRecorder.emit(taskId, event);
			notifyTaskStateChanged(taskId);
		},
		isClosed(taskId: string): boolean {
			return baseEventRecorder.isClosed(taskId);
		},
		async recordTaskFailure(taskId: string, reason: string): Promise<void> {
			await baseEventRecorder.recordTaskFailure(taskId, reason);
			notifyTaskStateChanged(taskId);
		},
	} satisfies TaskEventRecorder;

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
			void runTask(taskId, deps, workDir, tasks, eventRecorder, () =>
				finishActiveTask(taskId),
			).catch(async (error) => {
				await handleRunTaskEscape(
					taskId,
					error,
					tasks,
					eventRecorder,
					finishActiveTask,
					notifyTaskStateChanged,
				);
			});

			return { taskId, status: 'accepted' };
		},

		getActiveTaskId(): string | null {
			return activeTaskId;
		},

		getTaskState(taskId: string): TaskState | undefined {
			return tasks.get(taskId);
		},

		async waitForTaskStatus(
			taskId: string,
			status: TaskStatus,
			options: WaitForTaskStatusOptions = {},
		): Promise<TaskState> {
			const state = tasks.get(taskId);
			if (state?.status === status) {
				return state;
			}
			if (state !== undefined && isTerminal(state)) {
				throw new Error(`Task ${taskId} reached terminal status ${state.status} before ${status}.`);
			}
			const timeoutMs = options.timeoutMs ?? defaultTaskStatusWaitTimeoutMs;
			return await new Promise<TaskState>((resolve, reject) => {
				const waiters = taskStatusWaiters.get(taskId) ?? [];
				const waiter: TaskStatusWaiter = {
					reject,
					resolve,
					status,
					timeout: setTimeout(() => {
						removeTaskStatusWaiter(taskId, waiter);
						reject(
							new Error(
								`Task ${taskId} did not reach ${status} within ${String(
									timeoutMs,
								)}ms. Last status: ${tasks.get(taskId)?.status ?? 'unknown'}.`,
							),
						);
					}, timeoutMs),
				};
				waiters.push(waiter);
				taskStatusWaiters.set(taskId, waiters);
			});
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
