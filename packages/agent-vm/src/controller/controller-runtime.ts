import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { configureHostNetworkDefaults, type ManagedVm } from '@agent-vm/gondolin-adapter';
import { createSecretResolver as createOnePasswordSecretResolver } from '@agent-vm/secret-management';

import { resolveControllerHealthConfig } from '../config/system-config.js';
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
import { appendDurableHealthEvent } from './health/durable-health-event-log.js';
import { classifyGatewayRecoveryAction } from './health/gateway-recovery-actions.js';
import { createGatewayServiceHealthMonitor } from './health/gateway-service-health-monitor.js';
import type {
	GatewayVmRecoveryBudgetClass,
	GatewayVmRecoveryReason,
} from './health/gateway-vm-recovery-policy.js';
import { createGatewayVmRecoveryRunner } from './health/gateway-vm-recovery-runner.js';
import { HealthEventStore } from './health/health-event-store.js';
import { createMutableControllerRuntimeReadiness } from './http/controller-http-route-support.js';
import { createControllerService } from './http/controller-http-routes.js';
import { startControllerHttpServer } from './http/controller-http-server.js';
import { createIdleReaper } from './leases/idle-reaper.js';
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
import type {
	GatewayChannelProviderPlane,
	GatewayDiagnosisSnapshot,
	GatewaySelectedZoneReadiness,
	GatewayToolVmPlane,
} from './zone-runtimes/gateway-zone-state-machine.js';
import { createOpenClawZoneRuntime } from './zone-runtimes/openclaw-zone-runtime.js';
import { createWorkerZoneRuntime } from './zone-runtimes/worker-zone-runtime.js';
import {
	ControllerZoneConfigurationError,
	ControllerZoneNotFoundError,
	ControllerZoneOperationUnsupportedError,
} from './zone-runtimes/zone-runtime-errors.js';
import { createZoneRuntimeRegistry } from './zone-runtimes/zone-runtime-registry.js';
import type { ControllerZoneConfig } from './zone-runtimes/zone-runtime-types.js';

export { classifyGatewayRecoveryRestartError } from './health/gateway-vm-recovery-runner.js';

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

function buildOpenClawRuntimePluginConfig(options: {
	readonly systemConfig: StartControllerRuntimeOptions['systemConfig'];
	readonly zoneGitCapabilityStore: ZoneGitCapabilityStore;
	readonly zoneId: string;
}): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
	const zoneGitRuntimePluginConfig = options.zoneGitCapabilityStore.buildRuntimePluginConfig(
		options.zoneId,
	);
	const healthConfig = resolveControllerHealthConfig(options.systemConfig);
	return {
		...zoneGitRuntimePluginConfig,
		gondolin: {
			...zoneGitRuntimePluginConfig.gondolin,
			gatewayControlLinkMonitor: {
				baseIntervalMs: healthConfig.gatewayControlLinkIntervalMs,
				enabled: healthConfig.enabled,
				maxIntervalMs: healthConfig.gatewayControlLinkBackoffCeilingMs,
			},
		},
	};
}

function channelProviderPlaneForHealth(
	health: 'healthy' | 'transitioning' | 'unhealthy-recoverable' | 'unhealthy-unrecoverable',
): GatewayChannelProviderPlane {
	switch (health) {
		case 'healthy':
			return 'ok';
		case 'transitioning':
			return 'transitioning';
		case 'unhealthy-recoverable':
			return 'degraded';
		case 'unhealthy-unrecoverable':
			return 'failed';
	}
	return assertNeverChannelProviderHealth(health);
}

function channelProviderPlaneRank(plane: GatewayChannelProviderPlane): number {
	switch (plane) {
		case 'failed':
			return 4;
		case 'degraded':
			return 3;
		case 'transitioning':
			return 2;
		case 'unknown':
			return 1;
		case 'ok':
			return 0;
	}
	return assertNeverChannelProviderPlane(plane);
}

function aggregateChannelProviderPlane(
	events: readonly Extract<
		AgentVmHealthEvent,
		{ readonly kind: 'agent-channel-provider-health' }
	>[],
	options: { readonly nowMs: number; readonly staleAfterMs: number },
): GatewayChannelProviderPlane {
	if (events.length === 0) {
		return 'unknown';
	}
	return (
		events
			.map((event) =>
				isHealthEventStale(event, options)
					? 'degraded'
					: channelProviderPlaneForHealth(event.health),
			)
			.toSorted(
				(leftPlane, rightPlane) =>
					channelProviderPlaneRank(rightPlane) - channelProviderPlaneRank(leftPlane),
			)[0] ?? 'unknown'
	);
}

function isHealthEventStale(
	event: Pick<AgentVmHealthEvent, 'observedAtMs'>,
	options: { readonly nowMs: number; readonly staleAfterMs: number },
): boolean {
	return options.nowMs - event.observedAtMs > options.staleAfterMs;
}

type ToolVmPlaneHealthEvent = Extract<
	AgentVmHealthEvent,
	{ readonly kind: 'lease-heartbeat' | 'lease-renew' | 'tool-vm-ssh' }
>;

function isToolVmPlaneHealthEvent(event: AgentVmHealthEvent): event is ToolVmPlaneHealthEvent {
	return (
		event.kind === 'lease-heartbeat' || event.kind === 'lease-renew' || event.kind === 'tool-vm-ssh'
	);
}

function toolVmPlaneForResult(result: ToolVmPlaneHealthEvent['result']): GatewayToolVmPlane {
	switch (result) {
		case 'ok':
			return 'ok';
		case 'failed':
			return 'failed';
		case 'stale':
		case 'timeout':
			return 'degraded';
	}
	return assertNeverToolVmHealthResult(result);
}

function toolVmPlaneRank(plane: GatewayToolVmPlane): number {
	switch (plane) {
		case 'failed':
			return 3;
		case 'degraded':
			return 2;
		case 'ok':
			return 1;
		case 'unknown':
			return 0;
	}
	return assertNeverToolVmPlane(plane);
}

function aggregateToolVmPlane(
	events: readonly ToolVmPlaneHealthEvent[],
	options: { readonly nowMs: number; readonly staleAfterMs: number },
): GatewayToolVmPlane {
	if (events.length === 0) {
		return 'unknown';
	}
	return (
		events
			.map((event) =>
				isHealthEventStale(event, options) ? 'degraded' : toolVmPlaneForResult(event.result),
			)
			.toSorted(
				(leftPlane, rightPlane) => toolVmPlaneRank(rightPlane) - toolVmPlaneRank(leftPlane),
			)[0] ?? 'unknown'
	);
}

function assertNeverChannelProviderHealth(health: never): never {
	throw new Error(`Unhandled channel provider health: ${String(health)}`);
}

function assertNeverChannelProviderPlane(plane: never): never {
	throw new Error(`Unhandled channel provider plane: ${String(plane)}`);
}

function assertNeverToolVmHealthResult(result: never): never {
	throw new Error(`Unhandled Tool VM health result: ${String(result)}`);
}

function assertNeverToolVmPlane(plane: never): never {
	throw new Error(`Unhandled Tool VM plane: ${String(plane)}`);
}

function readinessWithHealthPlanes(options: {
	readonly channelProviderPlane: GatewayChannelProviderPlane;
	readonly gatewayRuntimeHealthDegraded: boolean;
	readonly toolVmPlane: GatewayToolVmPlane;
	readonly readiness: GatewaySelectedZoneReadiness;
}): GatewaySelectedZoneReadiness {
	if (options.readiness === 'failed' || options.readiness === 'owner-unsafe') {
		return options.readiness;
	}
	if (
		options.channelProviderPlane === 'transitioning' ||
		options.channelProviderPlane === 'degraded' ||
		options.channelProviderPlane === 'failed'
	) {
		return 'degraded';
	}
	if (options.toolVmPlane === 'degraded' || options.toolVmPlane === 'failed') {
		return 'degraded';
	}
	if (options.gatewayRuntimeHealthDegraded) {
		return 'degraded';
	}
	return options.readiness;
}

function hasGatewayRuntimeHealthIssue(
	events: readonly AgentVmHealthEvent[],
	options: { readonly nowMs: number; readonly staleAfterMs: number },
): boolean {
	return events.some((event) => {
		if (event.kind !== 'gateway-control-link' && event.kind !== 'gateway-service-health') {
			return false;
		}
		return (
			isHealthEventStale(event, options) ||
			event.result === 'failed' ||
			event.result === 'stale' ||
			event.result === 'timeout'
		);
	});
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
	const hostNetworkDefaults = (
		dependencies.configureHostNetworkDefaults ?? configureHostNetworkDefaults
	)();
	writeControllerRuntimeLog(
		`Host network defaults: dnsResultOrder=${hostNetworkDefaults.dnsResultOrder} autoSelectFamily=${hostNetworkDefaults.autoSelectFamily}`,
	);
	const now = dependencies.now ?? Date.now;
	const runTaskStep =
		dependencies.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const secretResolver = await runTaskWithResult(
		runTaskStep,
		'Resolving 1Password secrets',
		async () =>
			await createSecretResolver(
				options.systemConfig,
				dependencies.createSecretResolver ?? createOnePasswordSecretResolver,
			),
	);
	const createFreshSecretResolver = async (): Promise<typeof secretResolver> =>
		await runTaskWithResult(
			runTaskStep,
			'Refreshing 1Password secret resolver',
			async () =>
				await createSecretResolver(
					options.systemConfig,
					dependencies.createSecretResolver ?? createOnePasswordSecretResolver,
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
				secretResolver: toolVmOptions.secretResolver,
			}));
	const tcpPool = createTcpPool(options.systemConfig.tcpPool);
	const activeTaskRegistry = new ActiveTaskRegistry();
	const requestHeartbeatRegistry = new RequestHeartbeatRegistry();
	const zoneGitCapabilityStore =
		dependencies.zoneGitCapabilityStore ?? new ZoneGitCapabilityStore();
	const zoneGitOperationLocks = dependencies.zoneGitOperationLocks ?? new ZoneGitOperationLocks();
	const controllerHealthConfig = resolveControllerHealthConfig(options.systemConfig);
	const healthEventStore = new HealthEventStore({
		durableEventLog: {
			append: async (event) => {
				await (dependencies.appendDurableHealthEvent ?? appendDurableHealthEvent)({
					controllerPid: process.pid,
					controllerPort: options.systemConfig.host.controllerPort,
					event,
					runtimeDir: options.systemConfig.runtimeDir,
				});
			},
		},
		eventHistoryLimit: controllerHealthConfig.eventHistoryLimit,
		staleAfterMs: controllerHealthConfig.staleAfterMs,
	});
	const stateDirFor = (zoneId: string): string => {
		const zone = options.systemConfig.zones.find((candidate) => candidate.id === zoneId);
		if (!zone) {
			throw new Error(`Unknown zone '${zoneId}' while resolving tool VM state directory.`);
		}
		return zone.gateway.stateDir;
	};
	const leaseManager = createLeaseManager({
		controllerPort: options.systemConfig.host.controllerPort,
		createManagedVm: async (leaseOptions) =>
			await createManagedToolVm({
				profile: leaseOptions.profile,
				tcpSlot: leaseOptions.tcpSlot,
				hostWorkMountDir: leaseOptions.hostWorkMountDir,
				...(leaseOptions.zoneGitMount ? { zoneGitMount: leaseOptions.zoneGitMount } : {}),
				zoneId: leaseOptions.zoneId,
				secretResolver,
			}),
		now,
		projectNamespace: options.systemConfig.host.projectNamespace,
		...(dependencies.readProcessIdentity !== undefined
			? { readProcessIdentity: dependencies.readProcessIdentity }
			: {}),
		stateDirFor,
		systemConfigPath: options.systemConfig.systemConfigPath,
		tcpPool,
	});
	const idleReaper = createIdleReaper({
		getLeases: () =>
			leaseManager.listLeases().map((lease) => ({
				activeUseCount: leaseManager.getActiveUseCount(lease.id),
				effectiveIdleTtlMs: lease.effectiveIdleTtlMs,
				id: lease.id,
				lastUsedAt: lease.lastUsedAt,
			})),
		now,
		releaseLease: async (
			leaseId: string,
			releaseOptions?: { readonly ifLastUsedAtBeforeOrAt?: number },
		) => {
			await leaseManager.releaseLease(leaseId, releaseOptions);
		},
	});
	const reapToolVmLeases = async (): Promise<void> => {
		leaseManager.reapExpiredActiveUses();
		// Prefer dead-VM eviction logs over idle-expiry logs when both are true.
		await leaseManager.reapDeadIdleLeases();
		await idleReaper.reapExpiredLeases();
	};
	const reaperTimer = (dependencies.setIntervalImpl ?? setInterval)(
		() =>
			reapToolVmLeases().catch((error: unknown) =>
				writeControllerRuntimeLog(
					`Tool VM lease reaper failed: ${error instanceof Error ? error.message : String(error)}`,
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
				await leaseManager.releaseLease(lease.id, { force: true });
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
						createFreshSecretResolver,
						...(dependencies.isProcessAlive ? { isProcessAlive: dependencies.isProcessAlive } : {}),
						leaseManager,
						now,
						restartGatewayZone: async (zoneId, startOptions) =>
							await (dependencies.startGatewayZone ?? startGatewayZone)({
								runTask: runTaskStep,
								runtimeEnvironment: zoneGitCapabilityStore.buildRuntimeEnvironment(zoneId),
								runtimePluginConfigs: buildOpenClawRuntimePluginConfig({
									systemConfig: options.systemConfig,
									zoneGitCapabilityStore,
									zoneId,
								}),
								secretResolver: startOptions?.secretResolver ?? secretResolver,
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

	const serverRef: { current?: { close(): Promise<void> } } = {};
	const runtimeReadiness = createMutableControllerRuntimeReadiness('recovering');
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
		releaseLease: async (leaseId: string, releaseOptions) =>
			await leaseManager.releaseLease(leaseId, releaseOptions),
		stopAllZones: async () => await registry.stopAllZones(),
	});
	const operations = {
		...createControllerRuntimeOperations({
			destroyZoneRuntime: async (zoneId, purge) => await registry.destroyZone(zoneId, purge),
			getActiveLeases: () => leaseManager.listLeases(),
			getOpenClawRuntime: (zoneId) => registry.getOpenClawRuntime(zoneId),
			getRuntimeDiagnosisByZone: () => {
				const diagnoses = registry.getDiagnosisByZone();
				const nowMs = now();
				return Object.fromEntries(
					Object.entries(diagnoses).map(([zoneId, diagnosis]) => {
						const latestHealthEvents = healthEventStore.listLatestEventsForZone(zoneId);
						const latestChannelProviderEvents = latestHealthEvents.filter(
							(
								event,
							): event is Extract<
								AgentVmHealthEvent,
								{ readonly kind: 'agent-channel-provider-health' }
							> => event.kind === 'agent-channel-provider-health',
						);
						const latestToolVmPlaneEvents = latestHealthEvents.filter(isToolVmPlaneHealthEvent);
						const latestGatewayRuntimeHealthEvents = latestHealthEvents.filter(
							(event) =>
								event.kind === 'gateway-control-link' || event.kind === 'gateway-service-health',
						);
						if (
							latestChannelProviderEvents.length === 0 &&
							latestToolVmPlaneEvents.length === 0 &&
							latestGatewayRuntimeHealthEvents.length === 0
						) {
							return [zoneId, diagnosis];
						}
						const channelProviderPlane =
							latestChannelProviderEvents.length === 0
								? diagnosis.channelProviderPlane
								: aggregateChannelProviderPlane(latestChannelProviderEvents, {
										nowMs,
										staleAfterMs: controllerHealthConfig.staleAfterMs,
									});
						const toolVmPlane =
							latestToolVmPlaneEvents.length === 0
								? diagnosis.toolVmPlane
								: aggregateToolVmPlane(latestToolVmPlaneEvents, {
										nowMs,
										staleAfterMs: controllerHealthConfig.staleAfterMs,
									});
						const gatewayRuntimeHealthDegraded = hasGatewayRuntimeHealthIssue(
							latestGatewayRuntimeHealthEvents,
							{
								nowMs,
								staleAfterMs: controllerHealthConfig.staleAfterMs,
							},
						);
						return [
							zoneId,
							{
								...diagnosis,
								channelProviderPlane,
								selectedZoneReadiness: readinessWithHealthPlanes({
									channelProviderPlane,
									gatewayRuntimeHealthDegraded,
									readiness: diagnosis.selectedZoneReadiness,
									toolVmPlane,
								}),
								toolVmPlane,
							} satisfies GatewayDiagnosisSnapshot,
						];
					}),
				);
			},
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
	const recoverGatewayVm = createGatewayVmRecoveryRunner({
		getRecoverableGatewayRuntime: (zoneId) => registry.getOpenClawRuntime(zoneId),
		getRuntimeReadiness: () => runtimeReadiness.get(),
		now,
		restartTimeoutMs: controllerHealthConfig.gatewayServiceAutoRestart.restartTimeoutMs,
		writeLog: writeControllerRuntimeLog,
	});
	const classifyRecoveryBudgetClass = (request: {
		readonly consecutiveFailures: number;
		readonly reason: GatewayVmRecoveryReason;
		readonly zoneId: string;
	}): GatewayVmRecoveryBudgetClass => {
		try {
			const runtime = registry.getOpenClawRuntime(request.zoneId);
			const action = classifyGatewayRecoveryAction({
				lifecycleState: runtime.getLifecycleState(),
				recoveryDecision: {
					consecutiveFailures: request.consecutiveFailures,
					kind: 'restart',
					reason: request.reason,
					zoneId: request.zoneId,
				},
			});
			return action.kind === 'cold-start-gateway' || action.kind === 'refresh-secret-resolver'
				? 'gateway-vm-cold-start'
				: 'gateway-vm-restart';
		} catch (error) {
			writeControllerRuntimeLog(
				`Gateway VM recovery budget classification failed for zone '${request.zoneId}': ${formatUnknownError(error)}`,
			);
			return 'gateway-vm-restart';
		}
	};
	const controllerApp = createControllerService({
		healthEventStore,
		leaseManager,
		...(dependencies.onLeaseCreateRequest
			? { onLeaseCreateRequest: dependencies.onLeaseCreateRequest }
			: {}),
		operations,
		...(dependencies.readIdentityPem ? { readIdentityPem: dependencies.readIdentityPem } : {}),
		runtimeReadiness: () => runtimeReadiness.get(),
		secretResolver,
		systemConfig: options.systemConfig,
	});
	await runTaskStep(`Controller API on :${options.systemConfig.host.controllerPort}`, async () => {
		serverRef.current = await (dependencies.startHttpServer ?? startControllerHttpServer)({
			app: controllerApp,
			port: options.systemConfig.host.controllerPort,
		});
	});
	try {
		await runTaskStep('Starting selected gateway zones', async () => {
			await registry.startSelectedZones();
		});
		runtimeReadiness.set('ready');
	} catch (error) {
		runtimeReadiness.set('stopping');
		await serverRef.current?.close();
		throw error;
	}

	await reapToolVmLeases();

	const gatewayServiceHealthMonitor = controllerHealthConfig.enabled
		? createGatewayServiceHealthMonitor({
				...(dependencies.clearIntervalImpl
					? { clearIntervalImpl: dependencies.clearIntervalImpl }
					: {}),
				gatewayServiceAutoRestart: controllerHealthConfig.gatewayServiceAutoRestart,
				healthEventStore,
				classifyRecoveryBudgetClass,
				intervalMs: controllerHealthConfig.gatewayServiceIntervalMs,
				now,
				probeZoneHealth: async (zoneId) => {
					const health = await operations.getZoneHealth(zoneId);
					if (typeof health.path !== 'string' || typeof health.port !== 'number') {
						throw new Error(
							`Zone '${zoneId}' health probe did not include gateway service path/port.`,
						);
					}
					return {
						ok: health.ok,
						path: health.path,
						port: health.port,
						...(typeof health.statusCode === 'number' ? { statusCode: health.statusCode } : {}),
						zoneId: health.zoneId,
					};
				},
				recoverGatewayVm,
				...(dependencies.setIntervalImpl ? { setIntervalImpl: dependencies.setIntervalImpl } : {}),
				staleAfterMs: controllerHealthConfig.staleAfterMs,
				zoneIds: registry.selectedZoneIds.filter((zoneId) => {
					const zone = options.systemConfig.zones.find((candidate) => candidate.id === zoneId);
					return zone ? isOpenClawZone(zone) : false;
				}),
			})
		: undefined;
	gatewayServiceHealthMonitor?.start();

	const snapshotByZone = registry.getSnapshotByZone();
	return {
		async close(): Promise<void> {
			runtimeReadiness.set('stopping');
			clearReaperTimer();
			await gatewayServiceHealthMonitor?.stop();
			await healthEventStore.flushDurableWrites();
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
			return Object.assign({ zoneId }, snapshot);
		}),
	};
}
