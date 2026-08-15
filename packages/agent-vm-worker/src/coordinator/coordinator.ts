import { getLogger } from '@logtape/logtape';

import { toSafeWorkerLogProperties } from '../shared/process-logging.js';
import type { TaskEvent, TaskStatus } from '../state/task-event-types.js';
import {
	createInitialState,
	hydrateTaskStates,
	isTerminal,
	type TaskState,
} from '../state/task-state.js';
import {
	createWorkerControlRuntimeEventPublisher,
	type WorkerControlRuntimeEventPublisher,
} from '../work-phase/controller-tools/worker-control-rpc-client.js';
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

const coordinatorLogger = getLogger(['agent-vm', 'worker', 'coordinator']);

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
	coordinatorLogger.error(
		'Worker task execution failed unexpectedly.',
		toSafeWorkerLogProperties({ event: 'task-run-failed', failureClass: 'unhandled', error }),
	);
	try {
		await eventRecorder.recordTaskFailure(taskId, reason);
	} catch (recordError) {
		coordinatorLogger.error(
			'Worker task failure could not be persisted.',
			toSafeWorkerLogProperties({
				event: 'task-failure-persistence-failed',
				failureClass: 'persistence-failed',
				error: recordError,
			}),
		);
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

function runtimeObservationStateFor(
	status: TaskStatus,
): 'closed' | 'failed' | 'running' | undefined {
	if (status === 'closed' || status === 'completed') {
		return 'closed';
	}
	if (status === 'failed') {
		return 'failed';
	}
	return 'running';
}

export async function createCoordinator(deps: CoordinatorDeps): Promise<Coordinator> {
	const workDir = deps.workDir ?? '/work';
	const tasks = await hydrateTaskStates(deps.config.stateDir);
	const closedTaskIds = new Set<string>();
	const taskStatusWaiters = new Map<string, TaskStatusWaiter[]>();
	const baseEventRecorder = createTaskEventRecorder(
		deps.config.stateDir,
		tasks,
		closedTaskIds,
		deps.onFatalPersistenceFailure,
	);
	const runtimeEventPublisher =
		deps.workerControlService === undefined
			? undefined
			: createWorkerControlRuntimeEventPublisher(deps.workerControlService);
	let activeTaskId: string | null = null;

	function publishWorkerControlCapacitySnapshot(): void {
		if (runtimeEventPublisher === undefined) {
			return;
		}
		void runtimeEventPublisher
			.emitCapacitySnapshot({
				...(activeTaskId === null ? {} : { activeTaskId }),
				observedAtMs: Date.now(),
				state: activeTaskId === null ? 'idle' : 'running',
			})
			.catch((error: unknown) => {
				coordinatorLogger.warn(
					'Worker capacity snapshot publication failed.',
					toSafeWorkerLogProperties({
						event: 'capacity-snapshot-publish-failed',
						failureClass: 'transport',
						error,
					}),
				);
			});
	}

	function publishWorkerControlRuntimeEvents(taskId: string): void {
		if (runtimeEventPublisher === undefined) {
			return;
		}
		const taskState = tasks.get(taskId);
		if (taskState === undefined) {
			return;
		}
		void publishWorkerControlRuntimeEventsAsync(
			runtimeEventPublisher,
			taskId,
			taskState.status,
		).catch((error: unknown) => {
			coordinatorLogger.warn(
				'Worker runtime event publication failed.',
				toSafeWorkerLogProperties({
					event: 'runtime-event-publish-failed',
					failureClass: 'transport',
					error,
				}),
			);
		});
	}

	async function publishWorkerControlRuntimeEventsAsync(
		publisher: WorkerControlRuntimeEventPublisher,
		taskId: string,
		status: TaskStatus,
	): Promise<void> {
		const observedAtMs = Date.now();
		await publisher.emitRuntimeObservation({
			observedAtMs,
			state: runtimeObservationStateFor(status),
			task: { taskId },
		});
		await publisher.emitRuntimeStatus({
			findings: [
				{
					id: `task-status:${taskId}`,
					ok: status !== 'failed',
					safeMessage: `Task ${taskId} status is ${status}.`,
					severity: status === 'failed' ? 'error' : 'info',
				},
			],
			observedAtMs,
			statusKind: 'task_status',
		});
	}

	function finishActiveTask(taskId: string): void {
		if (activeTaskId === taskId) {
			activeTaskId = null;
			publishWorkerControlCapacitySnapshot();
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
			publishWorkerControlRuntimeEvents(taskId);
		},
		isClosed(taskId: string): boolean {
			return baseEventRecorder.isClosed(taskId);
		},
		async recordTaskFailure(taskId: string, reason: string): Promise<void> {
			await baseEventRecorder.recordTaskFailure(taskId, reason);
			notifyTaskStateChanged(taskId);
			publishWorkerControlRuntimeEvents(taskId);
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
			publishWorkerControlCapacitySnapshot();
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
			return { status: 'closed' };
		},
	};
}
