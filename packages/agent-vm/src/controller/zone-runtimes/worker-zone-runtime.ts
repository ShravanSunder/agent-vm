import { appendEvent, type TaskEvent } from '@agent-vm/agent-vm-worker';
import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmImageCapability,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { runControllerDestroy as runControllerDestroyDefault } from '../../operations/destroy-zone.js';
import { containsManagedVmTerminationUnprovenError } from '../../shared/controller-managed-vm-termination.js';
import type { ActiveTaskRegistry, ActiveWorkerTask } from '../active-task-registry.js';
import {
	writeControllerDiagnostic,
	type ControllerDiagnosticTelemetry,
} from '../controller-diagnostic-logging.js';
import type { ControllerWorkerTaskRuntimeRecordTarget } from '../durable-state/controller-state-record-paths.js';
import { pullDefaultForTask, type PullDefaultRequest } from '../git-pull-default-operations.js';
import {
	pushBranchesForTask,
	type PushBranchRequest,
	type PushBranchResult,
} from '../git-push-operations.js';
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
	ControllerZoneTaskNotReadyError,
	ControllerZoneWorkerCloseAggregateError,
	ControllerZoneWorkerCloseError,
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
		| 'beginZoneDestroy'
		| 'clear'
		| 'countOccupiedForZone'
		| 'endZoneDestroy'
		| 'get'
		| 'listForZone'
		| 'releaseReservation'
		| 'setWorkerIngress'
		| 'tryReserve'
	>;
	readonly controllerGithubToken: string | null;
	readonly controllerEpoch: string;
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
	readonly managedVmFactory: ManagedVmFactory;
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmImages: ManagedVmImageCapability;
	readonly prepareWorkerTask?: typeof prepareWorkerTaskDefault;
	readonly requestHeartbeatRegistry: Pick<RequestHeartbeatRegistry, 'acquire' | 'release'>;
	readonly runControllerDestroy?: typeof runControllerDestroyDefault;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly workerRuntimeRecordTargetFor: (
		taskId: string,
	) => ControllerWorkerTaskRuntimeRecordTarget;
	readonly zone: WorkerZoneConfig;
}

async function recordActiveTaskEvent(options: {
	readonly event: TaskEvent;
	readonly eventLogPath: string;
}): Promise<void> {
	await appendEvent(options.eventLogPath, options.event);
}

function writeWorkerZoneRuntimeLog(telemetry: ControllerDiagnosticTelemetry): void {
	writeControllerDiagnostic('gateway', {
		event: 'gateway-health-diagnostic',
		level: 'warning',
		failureClass: 'failure',
		telemetry,
	});
}

async function closeActiveWorkerTask(activeTask: ActiveWorkerTask): Promise<void> {
	if (!activeTask.workerIngress) {
		throw new ControllerZoneTaskNotReadyError(
			activeTask.zoneId,
			activeTask.taskId,
			`Task '${activeTask.taskId}' in zone '${activeTask.zoneId}' is still preparing and cannot be destroyed safely yet.`,
		);
	}
	try {
		const response = await fetch(
			`http://${activeTask.workerIngress.host}:${String(activeTask.workerIngress.port)}/tasks/${activeTask.taskId}/close`,
			{ method: 'POST' },
		);
		if (!response.ok) {
			throw new ControllerZoneWorkerCloseError({
				body: await response.text(),
				httpStatus: response.status,
				taskId: activeTask.taskId,
				zoneId: activeTask.zoneId,
			});
		}
	} catch (error) {
		if (error instanceof ControllerZoneWorkerCloseError) {
			throw error;
		}
		throw new ControllerZoneWorkerCloseError({
			body: error instanceof Error ? error.message : String(error),
			httpStatus: 0,
			taskId: activeTask.taskId,
			zoneId: activeTask.zoneId,
		});
	}
}

export function createWorkerZoneRuntime(
	options: CreateWorkerZoneRuntimeOptions,
): WorkerZoneRuntime {
	const readTaskState = createTaskStateReader({ systemConfig: options.systemConfig }).read;

	async function pullDefaultForActiveTask(
		taskId: string,
		input: PullDefaultRequest,
	): Promise<Awaited<ReturnType<typeof pullDefaultForTask>>> {
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
	}

	async function pushBranchesForActiveTask(
		taskId: string,
		input: { readonly branches: readonly PushBranchRequest[] },
	): Promise<{ readonly results: readonly PushBranchResult[] }> {
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
	}

	async function closeActiveWorkerTasksForZone(zoneId: string): Promise<void> {
		const activeTasks = options.activeTaskRegistry.listForZone(zoneId);
		const occupiedTaskCount = options.activeTaskRegistry.countOccupiedForZone(zoneId);
		if (occupiedTaskCount > activeTasks.length) {
			const message = `Zone '${zoneId}' has ${String(occupiedTaskCount - activeTasks.length)} worker task reservation(s) still preparing and cannot be destroyed safely yet.`;
			writeWorkerZoneRuntimeLog({
				operation: 'destroy-refused-preparing-reservations',
				zoneId,
			});
			throw new ControllerZoneTaskNotReadyError(zoneId, null, message);
		}
		const preparingTask = activeTasks.find((activeTask) => !activeTask.workerIngress);
		if (preparingTask) {
			const message = `Task '${preparingTask.taskId}' in zone '${zoneId}' is still preparing and cannot be destroyed safely yet.`;
			writeWorkerZoneRuntimeLog({
				operation: 'destroy-refused-preparing-task',
				zoneId,
			});
			throw new ControllerZoneTaskNotReadyError(zoneId, preparingTask.taskId, message);
		}
		const closeResults = await Promise.allSettled(
			activeTasks.map(async (activeTask) => await closeActiveWorkerTask(activeTask)),
		);
		const closeFailures = closeResults.flatMap((result, index) => {
			const activeTask = activeTasks[index];
			if (result.status === 'fulfilled') {
				if (activeTask) {
					options.activeTaskRegistry.clear(activeTask.zoneId, activeTask.taskId);
				}
				return [];
			}
			if (result.reason instanceof ControllerZoneWorkerCloseError) {
				return [result.reason];
			}
			return activeTask
				? [
						new ControllerZoneWorkerCloseError({
							body: result.reason instanceof Error ? result.reason.message : String(result.reason),
							httpStatus: 0,
							taskId: activeTask.taskId,
							zoneId: activeTask.zoneId,
						}),
					]
				: [];
		});
		if (closeFailures.length === 1) {
			throw closeFailures[0];
		}
		if (closeFailures.length > 1) {
			throw new ControllerZoneWorkerCloseAggregateError(zoneId, closeFailures);
		}
	}

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
			await closeActiveWorkerTask(activeTask);
			return { status: 'closed' };
		},
		destroy: async (purge) => {
			let destroyGateAcquired = false;
			try {
				options.activeTaskRegistry.beginZoneDestroy(options.zone.id);
				destroyGateAcquired = true;
				return await (options.runControllerDestroy ?? runControllerDestroyDefault)(
					{ purge, systemConfig: options.systemConfig, zoneId: options.zone.id },
					{
						releaseZoneLeases: async () => {},
						stopGatewayZone: closeActiveWorkerTasksForZone,
					},
				);
			} finally {
				if (destroyGateAcquired) {
					options.activeTaskRegistry.endZoneDestroy(options.zone.id);
				}
			}
		},
		executeWorkerTask: async (prepared) => {
			let heartbeatAcquired = false;
			try {
				if (options.callerUrl) {
					options.requestHeartbeatRegistry.acquire(prepared.input.requestTaskId, options.callerUrl);
					heartbeatAcquired = true;
				}
				return await (options.executeWorkerTask ?? executeWorkerTaskDefault)(prepared, {
					controllerEpoch: options.controllerEpoch,
					controlSession: {
						controllerEpoch: options.controllerEpoch,
						operations: {
							pullDefaultForTask: pullDefaultForActiveTask,
							pushTaskBranches: pushBranchesForActiveTask,
						},
					},
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
					managedVmFactory: options.managedVmFactory,
					managedVmExactProcessTermination: options.managedVmExactProcessTermination,
					managedVmImages: options.managedVmImages,
					workerRuntimeRecordTarget: options.workerRuntimeRecordTargetFor(prepared.taskId),
				});
			} catch (error) {
				if (
					!containsManagedVmTerminationUnprovenError(error) &&
					options.activeTaskRegistry.get(prepared.zoneId, prepared.taskId)
				) {
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
			return await pullDefaultForActiveTask(taskId, input);
		},
		pushTaskBranches: async (
			taskId,
			input: { readonly branches: readonly PushBranchRequest[] },
		) => {
			return await pushBranchesForActiveTask(taskId, input);
		},
		shutdown: async () => {
			let destroyGateAcquired = false;
			try {
				options.activeTaskRegistry.beginZoneDestroy(options.zone.id);
				destroyGateAcquired = true;
				await closeActiveWorkerTasksForZone(options.zone.id);
			} finally {
				if (destroyGateAcquired) {
					options.activeTaskRegistry.endZoneDestroy(options.zone.id);
				}
			}
		},
		zoneId: options.zone.id,
	};
}
