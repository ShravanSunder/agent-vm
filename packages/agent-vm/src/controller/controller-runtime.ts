import { createOpCliSecretResolver, type ManagedVm } from '@agent-vm/gondolin-adapter';

import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { runTaskWithResult } from '../shared/run-task.js';
import { createToolVm } from '../tool-vm/tool-vm-lifecycle.js';
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
import type { PullDefaultRequest } from './git-pull-default-operations.js';
import type { PushBranchRequest } from './git-push-operations.js';
import { createControllerService } from './http/controller-http-routes.js';
import { startControllerHttpServer } from './http/controller-http-server.js';
import { createIdleReaper } from './leases/idle-reaper.js';
import { ttlForLeaseScope, type LeaseIdleTtlPolicy } from './leases/lease-idle-policy.js';
import { createLeaseManager } from './leases/lease-manager.js';
import { createTcpPool } from './leases/tcp-pool.js';
import { RequestHeartbeatRegistry } from './request-heartbeat-registry.js';
import type { PreparedWorkerTask, WorkerTaskInput } from './worker-task-runner.js';
import { ZoneGitCapabilityStore } from './zone-git/zone-git-capability-store.js';
import { ZoneGitOperationLocks } from './zone-git/zone-git-operation-locks.js';
import {
	getZoneGitStatus,
	pushZoneGit,
	type ZoneGitReadConfig,
} from './zone-git/zone-git-operations.js';
import { isOpenClawZoneGitConfigured } from './zone-git/zone-git-paths.js';
import { createOpenClawZoneRuntime } from './zone-runtimes/openclaw-zone-runtime.js';
import { createWorkerZoneRuntime } from './zone-runtimes/worker-zone-runtime.js';
import {
	ControllerZoneConfigurationError,
	ControllerZoneNotFoundError,
	ControllerZoneOperationUnsupportedError,
} from './zone-runtimes/zone-runtime-errors.js';
import { createZoneRuntimeRegistry } from './zone-runtimes/zone-runtime-registry.js';
import type { ControllerZoneConfig } from './zone-runtimes/zone-runtime-types.js';

const defaultLeaseIdleTtlPolicy = {
	defaultMs: 30 * 60 * 1000,
	byScopeKind: {},
	byScopePrefix: {},
} satisfies LeaseIdleTtlPolicy;

function writeControllerRuntimeLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return typeof error === 'string' ? error : JSON.stringify(error);
}

function isOpenClawZone(zone: ControllerZoneConfig): zone is ControllerZoneConfig & {
	readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'openclaw' }>;
} {
	return zone.gateway.type === 'openclaw';
}

function isWorkerZone(zone: ControllerZoneConfig): zone is ControllerZoneConfig & {
	readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'worker' }>;
} {
	return zone.gateway.type === 'worker';
}

function resolveZoneGitOperationConfig(options: {
	readonly controllerGithubToken: string | null;
	readonly systemConfig: StartControllerRuntimeOptions['systemConfig'];
	readonly zoneId: string;
}): ZoneGitReadConfig {
	let zone: ControllerZoneConfig;
	try {
		zone = findConfiguredZone(options.systemConfig, options.zoneId);
	} catch {
		throw new ControllerZoneNotFoundError(options.zoneId);
	}
	if (!isOpenClawZoneGitConfigured(zone)) {
		throw new ControllerZoneOperationUnsupportedError(
			options.zoneId,
			'OpenClaw zone Git operations',
			zone.gateway.type,
		);
	}
	if (!options.controllerGithubToken) {
		throw new ControllerZoneConfigurationError(
			options.zoneId,
			`zoneGit for zone '${options.zoneId}' requires host.githubToken so the controller can push without exposing credentials to VMs.`,
		);
	}
	return {
		branch: zone.gateway.zoneGit.remote.branch,
		githubToken: options.controllerGithubToken,
		remoteUrl: zone.gateway.zoneGit.remote.repoUrl,
		runtimeDir: options.systemConfig.runtimeDir,
		zoneFilesDir: zone.gateway.zoneFilesDir,
		zoneId: options.zoneId,
	};
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
	const createManagedToolVm =
		dependencies.createManagedToolVm ??
		(async (toolVmOptions): Promise<ManagedVm> =>
			await createToolVm({
				cacheDir: options.systemConfig.cacheDir,
				profile: toolVmOptions.profile,
				systemConfig: options.systemConfig,
				tcpSlot: toolVmOptions.tcpSlot,
				hostWorkMountDir: toolVmOptions.hostWorkMountDir,
				...(toolVmOptions.zoneGitMount ? { zoneGitMount: toolVmOptions.zoneGitMount } : {}),
				zoneId: toolVmOptions.zoneId,
			}));
	const tcpPool = createTcpPool(options.systemConfig.tcpPool);
	const activeTaskRegistry = new ActiveTaskRegistry();
	const requestHeartbeatRegistry = new RequestHeartbeatRegistry();
	const zoneGitCapabilityStore =
		dependencies.zoneGitCapabilityStore ?? new ZoneGitCapabilityStore();
	const zoneGitOperationLocks = dependencies.zoneGitOperationLocks ?? new ZoneGitOperationLocks();
	const leaseManager = createLeaseManager({
		createManagedVm: async (leaseOptions) =>
			await createManagedToolVm({
				profile: leaseOptions.profile,
				tcpSlot: leaseOptions.tcpSlot,
				hostWorkMountDir: leaseOptions.hostWorkMountDir,
				...(leaseOptions.zoneGitMount ? { zoneGitMount: leaseOptions.zoneGitMount } : {}),
				zoneId: leaseOptions.zoneId,
			}),
		now,
		tcpPool,
	});
	const idleReaper = createIdleReaper({
		getLeases: () => leaseManager.listLeases(),
		now,
		releaseLease: async (
			leaseId: string,
			releaseOptions?: { readonly ifLastUsedAtBeforeOrAt?: number },
		) => {
			await leaseManager.releaseLease(leaseId, releaseOptions);
		},
		ttlForLease: (lease) =>
			ttlForLeaseScope({
				policy: options.systemConfig.leaseIdleTtl ?? defaultLeaseIdleTtlPolicy,
				scopeKey: lease.scopeKey,
			}),
	});
	const reaperTimer = (dependencies.setIntervalImpl ?? setInterval)(
		() =>
			void idleReaper
				.reapExpiredLeases()
				.catch((error: unknown) =>
					writeControllerRuntimeLog(
						`Idle lease reaper failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				),
		60_000,
	);
	const clearReaperTimer = (): void =>
		(dependencies.clearIntervalImpl ?? clearInterval)(reaperTimer);
	const releaseAllLeases = async (): Promise<Error | undefined> => {
		const releaseErrors: Error[] = [];
		for (const lease of leaseManager.listLeases()) {
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
				await leaseManager.releaseLease(lease.id);
			} catch (error) {
				releaseErrors.push(error instanceof Error ? error : new Error(formatUnknownError(error)));
				writeControllerRuntimeLog(
					`Failed to release lease '${lease.id}' during controller shutdown: ${formatUnknownError(error)}`,
				);
			}
		}
		return releaseErrors.length === 0
			? undefined
			: new AggregateError(releaseErrors, 'Failed to release one or more leases.');
	};

	const registry = createZoneRuntimeRegistry({
		createRuntimeForZone: (zone) =>
			isOpenClawZone(zone)
				? createOpenClawZoneRuntime({
						...(dependencies.deleteGatewayRuntimeRecord
							? { deleteGatewayRuntimeRecord: dependencies.deleteGatewayRuntimeRecord }
							: {}),
						leaseManager,
						now,
						restartGatewayZone: async (zoneId) =>
							await (dependencies.startGatewayZone ?? startGatewayZone)({
								runTask: runTaskStep,
								runtimeEnvironment: zoneGitCapabilityStore.buildRuntimeEnvironment(zoneId),
								runtimePluginConfigs: zoneGitCapabilityStore.buildRuntimePluginConfig(zoneId),
								secretResolver,
								systemConfig: options.systemConfig,
								zoneId,
							}),
						secretResolver,
						systemConfig: options.systemConfig,
						zone,
					})
				: isWorkerZone(zone)
					? createWorkerZoneRuntime({
							activeTaskRegistry,
							...(process.env.CALLER_URL ? { callerUrl: process.env.CALLER_URL } : {}),
							controllerGithubToken,
							...(dependencies.executeWorkerTask
								? { executeWorkerTask: dependencies.executeWorkerTask }
								: {}),
							...(dependencies.onWorkerTaskFinished
								? { onWorkerTaskFinished: dependencies.onWorkerTaskFinished }
								: {}),
							...(dependencies.onWorkerTaskIngress
								? { onWorkerTaskIngress: dependencies.onWorkerTaskIngress }
								: {}),
							...(dependencies.onWorkerTaskPrepared
								? { onWorkerTaskPrepared: dependencies.onWorkerTaskPrepared }
								: {}),
							...(dependencies.prepareWorkerTask
								? { prepareWorkerTask: dependencies.prepareWorkerTask }
								: {}),
							requestHeartbeatRegistry,
							secretResolver,
							systemConfig: options.systemConfig,
							zone,
						})
					: (() => {
							throw new Error(`Unsupported gateway type for zone '${zone.id}'.`);
						})(),
		...(options.startupFailures ? { startupFailures: options.startupFailures } : {}),
		systemConfig: options.systemConfig,
		writeLog: writeControllerRuntimeLog,
		...(options.zoneIds ? { zoneIds: options.zoneIds } : {}),
	});

	await runTaskStep('Starting selected gateway zones', async () => {
		await registry.startSelectedZones();
	});

	const serverRef: { current?: { close(): Promise<void> } } = {};
	const stopController = createStopControllerOperation({
		clearReaperTimer,
		closeControllerServer: async () => {
			setTimeout(() => {
				void serverRef.current?.close().catch((error: unknown) => {
					writeControllerRuntimeLog(
						`Failed to close controller HTTP server after stop request: ${formatUnknownError(error)}`,
					);
				});
			}, 100);
		},
		getLeases: () => leaseManager.listLeases(),
		releaseLease: async (leaseId: string) => await leaseManager.releaseLease(leaseId),
		stopAllZones: async () => await registry.stopAllZones(),
	});
	const operations = {
		...createControllerRuntimeOperations({
			destroyZoneRuntime: async (zoneId, purge) => await registry.destroyZone(zoneId, purge),
			getActiveLeases: () => leaseManager.listLeases(),
			getOpenClawRuntime: (zoneId) => registry.getOpenClawRuntime(zoneId),
			getRuntimeStatusByZone: () => registry.getSnapshotByZone(),
			secretResolver,
			systemConfig: options.systemConfig,
		}),
		closeTaskForZone: async (zoneId: string, taskId: string) =>
			await registry.getWorkerRuntime(zoneId).closeTaskForZone(taskId),
		executeWorkerTask: async (prepared: PreparedWorkerTask) =>
			await registry.getWorkerRuntime(prepared.zoneId).executeWorkerTask(prepared),
		getTaskState: async (zoneId: string, taskId: string) =>
			await registry.getWorkerRuntime(zoneId).getTaskState(taskId),
		getZoneGitStatus: async (zoneId: string) =>
			await getZoneGitStatus(
				resolveZoneGitOperationConfig({
					controllerGithubToken,
					systemConfig: options.systemConfig,
					zoneId,
				}),
			),
		prepareWorkerTask: async (zoneId: string, input: WorkerTaskInput) =>
			await registry.getWorkerRuntime(zoneId).prepareWorkerTask(input),
		pullDefaultForTask: async (zoneId: string, taskId: string, input: PullDefaultRequest) =>
			await registry.getWorkerRuntime(zoneId).pullDefaultForTask(taskId, input),
		pushTaskBranches: async (
			zoneId: string,
			taskId: string,
			input: { readonly branches: readonly PushBranchRequest[] },
		) => await registry.getWorkerRuntime(zoneId).pushTaskBranches(taskId, input),
		pushZoneGit: async (zoneId: string, input: { readonly expectedHead: string }) =>
			await zoneGitOperationLocks.runExclusive(
				zoneId,
				async () =>
					await pushZoneGit({
						...resolveZoneGitOperationConfig({
							controllerGithubToken,
							systemConfig: options.systemConfig,
							zoneId,
						}),
						expectedHead: input.expectedHead,
					}),
			),
		verifyZoneGitPushToken: (zoneId: string, token: string | undefined) =>
			zoneGitCapabilityStore.verifyTokenForZone(zoneId, token),
		stopController,
	};
	const controllerApp = createControllerService({
		leaseManager,
		operations,
		secretResolver,
		systemConfig: options.systemConfig,
	});
	await runTaskStep(`Controller API on :${options.systemConfig.host.controllerPort}`, async () => {
		serverRef.current = await (dependencies.startHttpServer ?? startControllerHttpServer)({
			app: controllerApp,
			port: options.systemConfig.host.controllerPort,
		});
	});

	await idleReaper.reapExpiredLeases();

	const snapshotByZone = registry.getSnapshotByZone();
	return {
		async close(): Promise<void> {
			clearReaperTimer();
			requestHeartbeatRegistry.stopAll();
			const releaseError = await releaseAllLeases();
			let stopError: Error | undefined;
			try {
				await registry.stopAllZones();
			} catch (error) {
				stopError = error instanceof Error ? error : new Error(formatUnknownError(error));
			} finally {
				await serverRef.current?.close();
			}
			const closeErrors = [releaseError, stopError].filter(
				(error): error is Error => error !== undefined,
			);
			if (closeErrors.length === 1) {
				throw closeErrors[0];
			}
			if (closeErrors.length > 1) {
				throw new AggregateError(closeErrors, 'Controller shutdown failed in multiple steps.');
			}
		},
		controllerPort: options.systemConfig.host.controllerPort,
		zones: registry.selectedZoneIds.map((zoneId) => {
			const snapshot = snapshotByZone[zoneId] ?? { lifecycleState: 'stopped' as const };
			const runtimeZone = {
				lifecycleState: snapshot.lifecycleState,
				zoneId,
			};
			return Object.assign(
				runtimeZone,
				snapshot.gateway ? { ingress: snapshot.gateway.ingress, vmId: snapshot.gateway.vm.id } : {},
				snapshot.lastError ? { lastError: snapshot.lastError } : {},
			);
		}),
	};
}
