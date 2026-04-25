import { createOpCliSecretResolver, type ManagedVm } from '@agent-vm/gondolin-adapter';

import { deleteGatewayRuntimeRecord as deleteGatewayRuntimeRecordDefault } from '../gateway/gateway-runtime-record.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { runTaskWithResult } from '../shared/run-task.js';
import {
	cleanToolVmWorkspace,
	createToolVm,
	resolveToolVmWorkspaceDirectory,
} from '../tool-vm/tool-vm-lifecycle.js';
import { ActiveTaskRegistry } from './active-task-registry.js';
import {
	createControllerRuntimeOperations,
	createStopControllerOperation,
} from './controller-runtime-operations.js';
import {
	createSecretResolver,
	findConfiguredZone,
	resolveControllerGithubToken,
} from './controller-runtime-support.js';
import {
	type ControllerRuntime,
	type ControllerRuntimeDependencies,
	type StartControllerRuntimeOptions,
} from './controller-runtime-types.js';
import {
	pullDefaultForTask,
	PullDefaultValidationError,
	type PullDefaultRequest,
} from './git-pull-default-operations.js';
import {
	pushBranchesForTask,
	PushBranchesValidationError,
	type PushBranchRequest,
} from './git-push-operations.js';
import {
	ControllerRuntimeAtCapacityError,
	ControllerTaskNotReadyError,
} from './http/controller-http-route-support.js';
import { createControllerService } from './http/controller-http-routes.js';
import { startControllerHttpServer } from './http/controller-http-server.js';
import { createIdleReaper } from './leases/idle-reaper.js';
import { createLeaseManager } from './leases/lease-manager.js';
import { createTcpPool } from './leases/tcp-pool.js';
import { RequestHeartbeatRegistry } from './request-heartbeat-registry.js';
import { createTaskStateReader } from './task-state-reader.js';
import {
	executeWorkerTask as executeWorkerTaskDefault,
	prepareWorkerTask as prepareWorkerTaskDefault,
	type WorkerTaskInput,
} from './worker-task-runner.js';

const MAX_ACTIVE_TASKS_PER_RUNTIME = 1;

function writeControllerRuntimeLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return typeof error === 'string' ? error : JSON.stringify(error);
}

export async function startControllerRuntime(
	options: StartControllerRuntimeOptions,
	dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
	const now = dependencies.now ?? Date.now;
	const runTaskStep =
		dependencies.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const secretResolver = await runTaskWithResult(
		runTaskStep,
		'Resolving 1Password secrets',
		async () =>
			await createSecretResolver(
				options.systemConfig,
				dependencies.createSecretResolver ?? createOpCliSecretResolver,
			),
	);
	const controllerGithubToken = await resolveControllerGithubToken(
		options.systemConfig,
		secretResolver,
	);
	const callerUrl = process.env.CALLER_URL;
	const createManagedToolVm =
		dependencies.createManagedToolVm ??
		(async (toolVmOptions): Promise<ManagedVm> =>
			await createToolVm({
				cacheDir: options.systemConfig.cacheDir,
				profile: toolVmOptions.profile,
				systemConfig: options.systemConfig,
				tcpSlot: toolVmOptions.tcpSlot,
				workspaceDir: toolVmOptions.workspaceDir,
				zoneId: toolVmOptions.zoneId,
			}));
	const tcpPool = createTcpPool(options.systemConfig.tcpPool);
	const activeTaskRegistry = new ActiveTaskRegistry();
	const requestHeartbeatRegistry = new RequestHeartbeatRegistry();
	const activeZone = findConfiguredZone(options.systemConfig, options.zoneId);
	const leaseManager = createLeaseManager({
		cleanWorkspace: async ({ profile, tcpSlot, zoneId }) => {
			await cleanToolVmWorkspace(
				resolveToolVmWorkspaceDirectory({
					profile,
					tcpSlot,
					zoneId,
				}),
			);
		},
		createManagedVm: async (leaseOptions) =>
			await createManagedToolVm({
				profile: leaseOptions.profile,
				tcpSlot: leaseOptions.tcpSlot,
				workspaceDir: leaseOptions.workspaceDir,
				zoneId: leaseOptions.zoneId,
			}),
		now,
		tcpPool,
	});
	const idleReaper = createIdleReaper({
		getLeases: () => leaseManager.listLeases(),
		now,
		releaseLease: async (leaseId: string) => {
			await leaseManager.releaseLease(leaseId);
		},
		ttlMs: 30 * 60 * 1000,
	});
	const reaperTimer = (dependencies.setIntervalImpl ?? setInterval)(
		() => void idleReaper.reapExpiredLeases(),
		60_000,
	);
	const clearReaperTimer = (): void =>
		(dependencies.clearIntervalImpl ?? clearInterval)(reaperTimer);
	const releaseAllLeases = async (): Promise<Error | undefined> => {
		let releaseError: Error | undefined;
		for (const lease of leaseManager.listLeases()) {
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
				await leaseManager.releaseLease(lease.id);
			} catch (error) {
				releaseError ??= error instanceof Error ? error : new Error(formatUnknownError(error));
				writeControllerRuntimeLog(
					`Failed to release lease '${lease.id}' during controller shutdown: ${formatUnknownError(error)}`,
				);
			}
		}
		return releaseError;
	};
	const startGateway = async (): Promise<Awaited<ReturnType<typeof startGatewayZone>>> =>
		await (dependencies.startGatewayZone ?? startGatewayZone)({
			runTask: runTaskStep,
			secretResolver,
			systemConfig: options.systemConfig,
			zoneId: options.zoneId,
		});
	const zone = findConfiguredZone(options.systemConfig, options.zoneId);
	let gateway: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
	const requireGateway = (): Awaited<ReturnType<typeof startGatewayZone>> => {
		if (!gateway) {
			throw new Error('Gateway runtime is unavailable because the last restart did not complete.');
		}
		return gateway;
	};
	if (activeZone.gateway.type !== 'worker') {
		await runTaskStep('Starting gateway zone', async () => {
			gateway = await startGateway();
		});
	}
	const stopGatewayZone = async (): Promise<void> => {
		if (!gateway) {
			return;
		}
		const activeGateway = gateway;
		gateway = undefined;
		let closeError: unknown;
		try {
			await activeGateway.vm.close();
		} catch (error) {
			closeError = error;
		}
		let deleteRecordError: unknown;
		try {
			await (dependencies.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecordDefault)(
				zone.gateway.stateDir,
			);
		} catch (error) {
			deleteRecordError = error;
		}
		if (closeError) {
			throw closeError;
		}
		if (deleteRecordError) {
			throw deleteRecordError;
		}
	};
	const restartGatewayZone = async (): Promise<void> => {
		await stopGatewayZone();
		gateway = await startGateway();
	};
	const serverRef: { current?: { close(): Promise<void> } } = {};
	const stopController = createStopControllerOperation({
		clearReaperTimer,
		closeControllerServer: () => setTimeout(() => void serverRef.current?.close(), 100),
		getLeases: () => leaseManager.listLeases(),
		releaseLease: async (leaseId: string) => await leaseManager.releaseLease(leaseId),
		stopGatewayZone,
	});
	const controllerOperations =
		activeZone.gateway.type !== 'worker'
			? {
					...createControllerRuntimeOperations({
						activeZoneId: options.zoneId,
						getGateway: () => requireGateway(),
						getZone: (zoneId: string) => findConfiguredZone(options.systemConfig, zoneId),
						leaseManager,
						restartGatewayZone,
						secretResolver,
						stopGatewayZone,
						systemConfig: options.systemConfig,
					}),
					stopController,
				}
			: { stopController };
	const prepareWorkerTaskForZone =
		activeZone.gateway.type === 'worker'
			? async (zoneId: string, input: WorkerTaskInput) => {
					const reservationId = activeTaskRegistry.tryReserve(zoneId, MAX_ACTIVE_TASKS_PER_RUNTIME);
					if (!reservationId) {
						throw new ControllerRuntimeAtCapacityError(
							`Worker pod for zone '${zoneId}' is at capacity.`,
						);
					}
					try {
						return await (dependencies.prepareWorkerTask ?? prepareWorkerTaskDefault)({
							input,
							systemConfig: options.systemConfig,
							zoneId,
							...(controllerGithubToken ? { githubToken: controllerGithubToken } : {}),
							onTaskPrepared: async (task) => {
								activeTaskRegistry.activateReservation(zoneId, reservationId, task);
								try {
									await dependencies.onWorkerTaskPrepared?.(task);
								} catch (error) {
									activeTaskRegistry.clear(task.zoneId, task.taskId);
									throw error;
								}
							},
						});
					} catch (error) {
						activeTaskRegistry.releaseReservation(zoneId, reservationId);
						throw error;
					}
				}
			: undefined;
	const executePreparedWorkerTask =
		activeZone.gateway.type === 'worker'
			? async (prepared: Awaited<ReturnType<typeof prepareWorkerTaskDefault>>) => {
					let heartbeatAcquired = false;
					try {
						if (callerUrl) {
							requestHeartbeatRegistry.acquire(prepared.input.requestTaskId, callerUrl);
							heartbeatAcquired = true;
						}
						return await (dependencies.executeWorkerTask ?? executeWorkerTaskDefault)(prepared, {
							secretResolver,
							systemConfig: options.systemConfig,
							onWorkerTaskIngress: async (zoneId, taskId, workerIngress) => {
								activeTaskRegistry.setWorkerIngress(zoneId, taskId, workerIngress);
								await dependencies.onWorkerTaskIngress?.(zoneId, taskId, workerIngress);
							},
							onTaskFinished: async (finishedZoneId, taskId) => {
								activeTaskRegistry.clear(finishedZoneId, taskId);
								await dependencies.onWorkerTaskFinished?.(finishedZoneId, taskId);
							},
						});
					} catch (error) {
						if (activeTaskRegistry.get(prepared.zoneId, prepared.taskId)) {
							activeTaskRegistry.clear(prepared.zoneId, prepared.taskId);
						}
						throw error;
					} finally {
						if (heartbeatAcquired) {
							requestHeartbeatRegistry.release(prepared.input.requestTaskId);
						}
					}
				}
			: undefined;
	const getTaskState =
		activeZone.gateway.type === 'worker'
			? createTaskStateReader({ systemConfig: options.systemConfig }).read
			: undefined;
	const closeTaskForZone =
		activeZone.gateway.type === 'worker'
			? async (zoneId: string, taskId: string) => {
					const activeTask = activeTaskRegistry.get(zoneId, taskId);
					if (!activeTask) {
						throw new Error(`Task '${taskId}' is not active for zone '${zoneId}'.`);
					}
					if (!activeTask.workerIngress) {
						throw new ControllerTaskNotReadyError(
							`Task '${taskId}' in zone '${zoneId}' does not have a worker ingress yet.`,
						);
					}
					const response = await fetch(
						`http://${activeTask.workerIngress.host}:${String(activeTask.workerIngress.port)}/tasks/${taskId}/close`,
						{ method: 'POST' },
					);
					if (!response.ok) {
						throw new Error(`worker close returned HTTP ${String(response.status)}`);
					}
					return { status: 'closed' as const };
				}
			: undefined;
	const pushTaskBranches =
		activeZone.gateway.type === 'worker'
			? async (
					zoneId: string,
					taskId: string,
					input: { readonly branches: readonly PushBranchRequest[] },
				) => {
					const activeTask = activeTaskRegistry.get(zoneId, taskId);
					if (!activeTask) {
						throw new PushBranchesValidationError(
							`Task '${taskId}' is not active for zone '${zoneId}'.`,
						);
					}
					if (!controllerGithubToken) {
						throw new Error(
							'Controller GitHub token is not configured. Set host.githubToken or process.env.GITHUB_TOKEN.',
						);
					}
					return await pushBranchesForTask({
						activeTask,
						branches: input.branches,
						githubToken: controllerGithubToken,
					});
				}
			: undefined;
	const pullDefaultForActiveTask =
		activeZone.gateway.type === 'worker'
			? async (zoneId: string, taskId: string, input: PullDefaultRequest) => {
					const activeTask = activeTaskRegistry.get(zoneId, taskId);
					if (!activeTask) {
						throw new PullDefaultValidationError(
							`Task '${taskId}' is not active for zone '${zoneId}'.`,
						);
					}
					if (!controllerGithubToken) {
						throw new Error(
							'Controller GitHub token is not configured. Set host.githubToken or process.env.GITHUB_TOKEN.',
						);
					}
					return await pullDefaultForTask({
						activeTask,
						repoUrl: input.repoUrl,
						githubToken: controllerGithubToken,
					});
				}
			: undefined;
	const operations = {
		...controllerOperations,
		...(prepareWorkerTaskForZone ? { prepareWorkerTask: prepareWorkerTaskForZone } : {}),
		...(executePreparedWorkerTask ? { executeWorkerTask: executePreparedWorkerTask } : {}),
		...(getTaskState ? { getTaskState } : {}),
		...(closeTaskForZone ? { closeTaskForZone } : {}),
		...(pushTaskBranches ? { pushTaskBranches } : {}),
		...(pullDefaultForActiveTask ? { pullDefaultForTask: pullDefaultForActiveTask } : {}),
	};
	const controllerApp = createControllerService({
		leaseManager,
		operations,
		systemConfig: options.systemConfig,
	});
	await runTaskStep(`Controller API on :${options.systemConfig.host.controllerPort}`, async () => {
		serverRef.current = await (dependencies.startHttpServer ?? startControllerHttpServer)({
			app: controllerApp,
			port: options.systemConfig.host.controllerPort,
		});
	});

	await idleReaper.reapExpiredLeases();

	return {
		async close(): Promise<void> {
			clearReaperTimer();
			requestHeartbeatRegistry.stopAll();
			const releaseError = await releaseAllLeases();
			try {
				await stopGatewayZone();
			} finally {
				await serverRef.current?.close();
			}
			if (releaseError) {
				throw releaseError;
			}
		},
		controllerPort: options.systemConfig.host.controllerPort,
		...(gateway
			? {
					gateway: {
						ingress: requireGateway().ingress,
						processSpec: requireGateway().processSpec,
						vm: requireGateway().vm,
					},
				}
			: {}),
	};
}
