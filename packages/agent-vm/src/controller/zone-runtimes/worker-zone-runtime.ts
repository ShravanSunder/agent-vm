import { appendEvent, type TaskEvent } from '@agent-vm/agent-vm-worker';
import type { SecretResolver } from '@agent-vm/gondolin-adapter';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { runControllerDestroy as runControllerDestroyDefault } from '../../operations/destroy-zone.js';
import type { ActiveTaskRegistry, ActiveWorkerTask } from '../active-task-registry.js';
import { pullDefaultForTask, type PullDefaultRequest } from '../git-pull-default-operations.js';
import { pushBranchesForTask, type PushBranchRequest } from '../git-push-operations.js';
import {
	ControllerRuntimeAtCapacityError,
	ControllerTaskNotReadyError,
} from '../http/controller-http-route-support.js';
import type { RequestHeartbeatRegistry } from '../request-heartbeat-registry.js';
import { createTaskStateReader } from '../task-state-reader.js';
import {
	executeWorkerTask as executeWorkerTaskDefault,
	prepareWorkerTask as prepareWorkerTaskDefault,
	type PreparedWorkerTask,
	type WorkerTaskInput,
	type WorkerTaskResult,
} from '../worker-task-runner.js';
import {
	ControllerZoneConfigurationError,
	ControllerZoneTaskNotFoundError,
} from './zone-runtime-errors.js';
import type { ControllerZoneConfig, WorkerZoneRuntime } from './zone-runtime-types.js';

const MAX_ACTIVE_TASKS_PER_RUNTIME = 1;

type WorkerZoneConfig = ControllerZoneConfig & {
	readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'worker' }>;
};

export interface CreateWorkerZoneRuntimeOptions {
	readonly activeTaskRegistry: Pick<
		ActiveTaskRegistry,
		| 'activateReservation'
		| 'clear'
		| 'get'
		| 'listForZone'
		| 'releaseReservation'
		| 'setWorkerIngress'
		| 'tryReserve'
	>;
	readonly controllerGithubToken: string | null;
	readonly callerUrl?: string;
	readonly executeWorkerTask?: (
		prepared: PreparedWorkerTask,
		dependencies: Parameters<typeof executeWorkerTaskDefault>[1],
	) => Promise<WorkerTaskResult>;
	readonly onWorkerTaskFinished?: (zoneId: string, taskId: string) => void | Promise<void>;
	readonly onWorkerTaskIngress?: (
		zoneId: string,
		taskId: string,
		workerIngress: { readonly host: string; readonly port: number },
	) => void | Promise<void>;
	readonly onWorkerTaskPrepared?: (task: ActiveWorkerTask) => void | Promise<void>;
	readonly prepareWorkerTask?: typeof prepareWorkerTaskDefault;
	readonly requestHeartbeatRegistry: Pick<RequestHeartbeatRegistry, 'acquire' | 'release'>;
	readonly runControllerDestroy?: typeof runControllerDestroyDefault;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly zone: WorkerZoneConfig;
}

async function recordActiveTaskEvent(options: {
	readonly event: TaskEvent;
	readonly eventLogPath: string;
}): Promise<void> {
	await appendEvent(options.eventLogPath, options.event);
}

export function createWorkerZoneRuntime(
	options: CreateWorkerZoneRuntimeOptions,
): WorkerZoneRuntime {
	const readTaskState = createTaskStateReader({ systemConfig: options.systemConfig }).read;

	return {
		closeTaskForZone: async (taskId) => {
			const activeTask = options.activeTaskRegistry.get(options.zone.id, taskId);
			if (!activeTask) {
				throw new ControllerZoneTaskNotFoundError(options.zone.id, taskId);
			}
			if (!activeTask.workerIngress) {
				throw new ControllerTaskNotReadyError(
					`Task '${taskId}' in zone '${options.zone.id}' does not have a worker ingress yet.`,
				);
			}
			const response = await fetch(
				`http://${activeTask.workerIngress.host}:${String(activeTask.workerIngress.port)}/tasks/${taskId}/close`,
				{ method: 'POST' },
			);
			if (!response.ok) {
				throw new Error(`worker close returned HTTP ${String(response.status)}`);
			}
			return { status: 'closed' };
		},
		destroy: async (purge) =>
			await (options.runControllerDestroy ?? runControllerDestroyDefault)(
				{ purge, systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					releaseZoneLeases: async () => {},
					stopGatewayZone: async (zoneId) => {
						for (const activeTask of options.activeTaskRegistry.listForZone(zoneId)) {
							if (activeTask.workerIngress) {
								// oxlint-disable-next-line no-await-in-loop -- worker close requests are scoped to active task order
								const response = await fetch(
									`http://${activeTask.workerIngress.host}:${String(activeTask.workerIngress.port)}/tasks/${activeTask.taskId}/close`,
									{ method: 'POST' },
								);
								if (!response.ok) {
									throw new Error(
										`worker close returned HTTP ${String(response.status)} for task '${activeTask.taskId}'`,
									);
								}
							}
							options.activeTaskRegistry.clear(activeTask.zoneId, activeTask.taskId);
						}
					},
				},
			),
		executeWorkerTask: async (prepared) => {
			let heartbeatAcquired = false;
			try {
				if (options.callerUrl) {
					options.requestHeartbeatRegistry.acquire(prepared.input.requestTaskId, options.callerUrl);
					heartbeatAcquired = true;
				}
				return await (options.executeWorkerTask ?? executeWorkerTaskDefault)(prepared, {
					onTaskFinished: async (finishedZoneId, taskId) => {
						options.activeTaskRegistry.clear(finishedZoneId, taskId);
						await options.onWorkerTaskFinished?.(finishedZoneId, taskId);
					},
					onWorkerTaskIngress: async (zoneId, taskId, workerIngress) => {
						options.activeTaskRegistry.setWorkerIngress(zoneId, taskId, workerIngress);
						await options.onWorkerTaskIngress?.(zoneId, taskId, workerIngress);
					},
					secretResolver: options.secretResolver,
					systemConfig: options.systemConfig,
				});
			} catch (error) {
				if (options.activeTaskRegistry.get(prepared.zoneId, prepared.taskId)) {
					options.activeTaskRegistry.clear(prepared.zoneId, prepared.taskId);
				}
				throw error;
			} finally {
				if (heartbeatAcquired) {
					options.requestHeartbeatRegistry.release(prepared.input.requestTaskId);
				}
			}
		},
		gatewayType: 'worker',
		getSnapshot: () => ({
			lifecycleState:
				options.activeTaskRegistry.listForZone(options.zone.id).length > 0 ? 'running' : 'stopped',
		}),
		getTaskState: async (taskId) => await readTaskState(options.zone.id, taskId),
		prepareWorkerTask: async (input: WorkerTaskInput) => {
			const reservationId = options.activeTaskRegistry.tryReserve(
				options.zone.id,
				MAX_ACTIVE_TASKS_PER_RUNTIME,
			);
			if (!reservationId) {
				throw new ControllerRuntimeAtCapacityError(
					`Worker pod for zone '${options.zone.id}' is at capacity.`,
				);
			}
			try {
				return await (options.prepareWorkerTask ?? prepareWorkerTaskDefault)({
					...(options.controllerGithubToken ? { githubToken: options.controllerGithubToken } : {}),
					input,
					onTaskPrepared: async (task) => {
						options.activeTaskRegistry.activateReservation(options.zone.id, reservationId, task);
						await options.onWorkerTaskPrepared?.(task);
					},
					systemConfig: options.systemConfig,
					zoneId: options.zone.id,
				});
			} catch (error) {
				options.activeTaskRegistry.releaseReservation(options.zone.id, reservationId);
				throw error;
			}
		},
		pullDefaultForTask: async (taskId, input: PullDefaultRequest) => {
			const activeTask = options.activeTaskRegistry.get(options.zone.id, taskId);
			if (!activeTask) {
				throw new ControllerZoneTaskNotFoundError(options.zone.id, taskId);
			}
			if (!options.controllerGithubToken) {
				throw new ControllerZoneConfigurationError(
					options.zone.id,
					'Controller GitHub token is not configured. Set host.githubToken or process.env.GITHUB_TOKEN.',
				);
			}
			return await pullDefaultForTask({
				activeTask,
				...(input.currentBranch !== undefined ? { currentBranch: input.currentBranch } : {}),
				...(input.currentHead !== undefined ? { currentHead: input.currentHead } : {}),
				githubToken: options.controllerGithubToken,
				recordEvent: async (event) => {
					await recordActiveTaskEvent({
						event,
						eventLogPath: activeTask.eventLogPath,
					});
				},
				repoUrl: input.repoUrl,
				...(input.worktreeDirty !== undefined ? { worktreeDirty: input.worktreeDirty } : {}),
			});
		},
		pushTaskBranches: async (
			taskId,
			input: { readonly branches: readonly PushBranchRequest[] },
		) => {
			const activeTask = options.activeTaskRegistry.get(options.zone.id, taskId);
			if (!activeTask) {
				throw new ControllerZoneTaskNotFoundError(options.zone.id, taskId);
			}
			if (!options.controllerGithubToken) {
				throw new ControllerZoneConfigurationError(
					options.zone.id,
					'Controller GitHub token is not configured. Set host.githubToken or process.env.GITHUB_TOKEN.',
				);
			}
			return await pushBranchesForTask({
				activeTask,
				branches: input.branches,
				githubToken: options.controllerGithubToken,
				recordEvent: async (event) => {
					await recordActiveTaskEvent({
						event,
						eventLogPath: activeTask.eventLogPath,
					});
				},
			});
		},
		shutdown: async () => {},
		zoneId: options.zone.id,
	};
}
