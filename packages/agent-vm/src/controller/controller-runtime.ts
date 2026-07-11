import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { configureHostNetworkDefaults, type ManagedVm } from '@agent-vm/gondolin-adapter';
import { createSecretResolver as createOnePasswordSecretResolver } from '@agent-vm/secret-management';

import { resolveCliVersion } from '../cli/cli-version.js';
import { resolveControllerHealthConfig } from '../config/system-config.js';
import {
	preflightGatewayZoneStart as preflightGatewayZoneStartDefault,
	startGatewayZone,
} from '../gateway/gateway-zone-orchestrator.js';
import { resolveControllerTelemetryIdentity as resolveControllerTelemetryIdentityDefault } from '../observability/controller-telemetry-identity.js';
import {
	startControllerTelemetry as startControllerTelemetryDefault,
	type ControllerTelemetry,
	type ControllerTelemetryProofAttributes,
} from '../observability/controller-telemetry.js';
import {
	createObservabilityRuntimeConfig,
	type EnabledObservabilityRuntimeConfig,
} from '../observability/observability-config.js';
import { checkObservabilityStackReadiness as checkObservabilityStackReadinessDefault } from '../observability/observability-readiness.js';
import { runTaskWithResult } from '../shared/run-task.js';
import { createToolVm } from '../tool-vm/tool-vm-lifecycle.js';
import { ActiveTaskRegistry } from './active-task-registry.js';
import { authorizeGatewayControlControllerHostAction } from './control-session/gateway-control-controller-host-action-authorization.js';
import type { GatewayControlControllerHostActionOperations } from './control-session/gateway-control-domain-handler.js';
import {
	createGatewayControlLeaseRpcOperations,
	createGatewayControlProcessAdmissionCoordinator,
} from './control-session/index.js';
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
import {
	classifyLifecycleAwareToolVmStatus,
	type ToolVmStatusActiveUseView,
	type ToolVmStatusLeaseView,
} from './health/tool-vm-status-aggregation.js';
import { createMutableControllerRuntimeReadiness } from './http/controller-http-route-support.js';
import { createControllerService } from './http/controller-http-routes.js';
import { startControllerHttpServer } from './http/controller-http-server.js';
import { createIdleReaper } from './leases/idle-reaper.js';
import { createLeaseManager } from './leases/lease-manager.js';
import { createOpenClawToolVmLeaseCreateOptionsResolver } from './leases/openclaw-tool-vm-lease-create-options.js';
import { createTcpPool } from './leases/tcp-pool.js';
import { OpenClawRuntimeStatusStore } from './openclaw-runtime-status.js';
import { RequestHeartbeatRegistry } from './request-heartbeat-registry.js';
import { acquireControllerOwnershipLock as acquireControllerOwnershipLockDefault } from './vm-ownership/controller-ownership-lock.js';
import { createGatewayDestructionBudget } from './vm-ownership/gateway-destruction-budget.js';
import { createGatewayOwnershipCoordinator } from './vm-ownership/gateway-ownership-coordinator.js';
import { containsGatewayOwnershipCoordinatorErrorCode } from './vm-ownership/gateway-ownership-errors.js';
import {
	createGatewayVmCreationOwnership,
	type VmCreationOwnership,
} from './vm-ownership/vm-creation-ownership.js';
import { vmOwnershipDeploymentIdentityForSystemConfig } from './vm-ownership/vm-ownership-deployment-identity.js';
import { standaloneVmOwnershipReservationRoot } from './vm-ownership/vm-ownership-reservation-inventory.js';
import type { PreparedWorkerTask, WorkerTaskInput } from './worker-task-runner.js';
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

const controllerHostProbeMarkerFileName = 'agent-vm-host-probe.txt';

function writeControllerRuntimeLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return typeof error === 'string' ? error : JSON.stringify(error);
}

function readNonEmptyEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value && value.length > 0 ? value : undefined;
}

function createControllerTelemetryProofAttributes():
	| ControllerTelemetryProofAttributes
	| undefined {
	const marker = readNonEmptyEnv('AGENT_VM_OBSERVABILITY_MARKER');
	const startedAt = readNonEmptyEnv('AGENT_VM_OBSERVABILITY_QUERY_START');
	const stateFile = readNonEmptyEnv('AGENT_VM_OBSERVABILITY_STATE_FILE');
	if (!marker && !startedAt && !stateFile) {
		return undefined;
	}
	return {
		...(marker ? { marker } : {}),
		...(startedAt ? { startedAt } : {}),
		...(stateFile ? { stateFile } : {}),
	};
}

function getDeploymentRootForSystemConfig(systemConfigPath: string): string {
	return path.resolve(path.dirname(systemConfigPath), '..');
}

async function flushControllerTelemetry(
	controllerTelemetry: ControllerTelemetry | undefined,
): Promise<void> {
	if (!controllerTelemetry) {
		return;
	}
	try {
		await controllerTelemetry.forceFlush();
	} catch (error) {
		writeControllerRuntimeLog(`Controller telemetry flush failed: ${formatUnknownError(error)}`);
	}
}

async function shutdownControllerTelemetry(
	controllerTelemetry: ControllerTelemetry | undefined,
): Promise<void> {
	if (!controllerTelemetry) {
		return;
	}
	try {
		await controllerTelemetry.shutdown();
	} catch (error) {
		writeControllerRuntimeLog(`Controller telemetry shutdown failed: ${formatUnknownError(error)}`);
	}
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

function selectConfiguredObservabilityStartupCheck(options: {
	readonly systemConfig: StartControllerRuntimeOptions['systemConfig'];
	readonly zoneIds?: readonly string[];
}): EnabledObservabilityRuntimeConfig | undefined {
	const observabilityConfig = createObservabilityRuntimeConfig(options.systemConfig);
	if (!observabilityConfig.enabled || observabilityConfig.controllerStartPolicy === 'off') {
		return undefined;
	}
	const selectedZoneIds = new Set(
		options.zoneIds ?? options.systemConfig.zones.map((zone) => zone.id),
	);
	const selectedZones = observabilityConfig.zones.filter((zone) =>
		selectedZoneIds.has(zone.zoneId),
	);
	if (selectedZones.length === 0) {
		return undefined;
	}
	return {
		...observabilityConfig,
		zones: selectedZones,
	};
}

async function assertObservabilityStackReady(options: {
	readonly checkObservabilityStackReadiness: NonNullable<
		ControllerRuntimeDependencies['checkObservabilityStackReadiness']
	>;
	readonly config: EnabledObservabilityRuntimeConfig;
}): Promise<void> {
	const result = await options.checkObservabilityStackReadiness({ config: options.config });
	if (!result.ok) {
		throw new Error(`Host observability stack is not ready: ${result.reason}`);
	}
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

function assertNeverChannelProviderHealth(health: never): never {
	throw new Error(`Unhandled channel provider health: ${String(health)}`);
}

function assertNeverChannelProviderPlane(plane: never): never {
	throw new Error(`Unhandled channel provider plane: ${String(plane)}`);
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
		if (event.kind !== 'gateway-control-session' && event.kind !== 'gateway-service-health') {
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
		defaultBranch: zone.gateway.zoneGit.remote.defaultBranch,
		githubToken: options.controllerGithubToken,
		protectedBranches: zone.gateway.zoneGit.remote.protectedBranches,
		protectedBranchPatterns: zone.gateway.zoneGit.remote.protectedBranchPatterns,
		remoteUrl: zone.gateway.zoneGit.remote.repoUrl,
		runtimeDir: options.systemConfig.runtimeDir,
		zoneFilesDir: zone.gateway.zoneFilesDir,
		zoneId: options.zoneId,
	};
}

async function startControllerRuntimeWithOwnershipLock(
	options: StartControllerRuntimeOptions,
	dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
	const now = dependencies.now ?? Date.now;
	const controllerEpoch = dependencies.controllerEpoch ?? randomUUID();
	const gatewayControlProcessAdmissionCoordinator =
		createGatewayControlProcessAdmissionCoordinator();
	const stateDirFor = (zoneId: string): string => {
		const zone = options.systemConfig.zones.find((candidate) => candidate.id === zoneId);
		if (!zone) {
			throw new Error(`Unknown zone '${zoneId}' while resolving tool VM state directory.`);
		}
		return zone.gateway.stateDir;
	};
	const gatewayDestructionBudget = createGatewayDestructionBudget();
	const ownershipCoordinator = (
		dependencies.createGatewayOwnershipCoordinator ?? createGatewayOwnershipCoordinator
	)({
		controllerEpoch,
		createId: randomUUID,
		deploymentIdentity: vmOwnershipDeploymentIdentityForSystemConfig(options.systemConfig),
		destructionBudget: gatewayDestructionBudget,
		nowMs: now,
		standaloneReservationRoot: standaloneVmOwnershipReservationRoot(
			options.systemConfig.runtimeDir,
		),
		stateDirectoryForZone: stateDirFor,
	});
	await ownershipCoordinator.reconcileControllerStartup(
		options.systemConfig.zones.filter(isOpenClawZone).map((zone) => zone.id),
	);
	const hostNetworkDefaults = (
		dependencies.configureHostNetworkDefaults ?? configureHostNetworkDefaults
	)();
	writeControllerRuntimeLog(
		`Host network defaults: dnsResultOrder=${hostNetworkDefaults.dnsResultOrder} autoSelectFamily=${hostNetworkDefaults.autoSelectFamily}`,
	);
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
				agentId: toolVmOptions.agentId,
				cacheDir: options.systemConfig.cacheDir,
				ownershipReservation: toolVmOptions.ownershipReservation,
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
	const zoneGitOperationLocks = dependencies.zoneGitOperationLocks ?? new ZoneGitOperationLocks();
	const controllerHealthConfig = resolveControllerHealthConfig(options.systemConfig);
	const observabilityRuntimeConfig = createObservabilityRuntimeConfig(options.systemConfig);
	let controllerTelemetry: ControllerTelemetry | undefined;
	if (observabilityRuntimeConfig.enabled) {
		try {
			const serviceVersion = await (
				dependencies.resolveControllerTelemetryServiceVersion ?? resolveCliVersion
			)();
			const identity = await (
				dependencies.resolveControllerTelemetryIdentity ?? resolveControllerTelemetryIdentityDefault
			)({
				cwd: getDeploymentRootForSystemConfig(options.systemConfig.systemConfigPath),
				serviceVersion,
			});
			controllerTelemetry = (
				dependencies.startControllerTelemetry ?? startControllerTelemetryDefault
			)({
				identity,
				observabilityConfig: observabilityRuntimeConfig,
				projectNamespace: options.systemConfig.host.projectNamespace,
				proof: createControllerTelemetryProofAttributes(),
			});
		} catch (error) {
			writeControllerRuntimeLog(
				`Controller telemetry disabled after startup failure: ${formatUnknownError(error)}`,
			);
		}
	}
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
		...(controllerTelemetry ? { healthEventSinks: [controllerTelemetry.healthEventSink] } : {}),
		staleAfterMs: controllerHealthConfig.staleAfterMs,
	});
	const leaseManager = createLeaseManager({
		controllerPort: options.systemConfig.host.controllerPort,
		createManagedVm: async (leaseOptions) =>
			await createManagedToolVm({
				agentId: leaseOptions.agentId,
				ownershipReservation: leaseOptions.ownershipReservation,
				profile: leaseOptions.profile,
				tcpSlot: leaseOptions.tcpSlot,
				hostWorkMountDir: leaseOptions.hostWorkMountDir,
				...(leaseOptions.zoneGitMount ? { zoneGitMount: leaseOptions.zoneGitMount } : {}),
				zoneId: leaseOptions.zoneId,
				secretResolver,
			}),
		now,
		ownershipCoordinator,
		projectNamespace: options.systemConfig.host.projectNamespace,
		...(dependencies.readProcessIdentity !== undefined
			? { readProcessIdentity: dependencies.readProcessIdentity }
			: {}),
		stateDirFor,
		systemConfigPath: options.systemConfig.systemConfigPath,
		tcpPool,
	});
	const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore({ nowMs: now });
	const resolveOpenClawToolVmLeaseCreateOptions = createOpenClawToolVmLeaseCreateOptionsResolver({
		...(options.systemConfig.leaseIdleTtl === undefined
			? {}
			: { leaseIdleTtlPolicy: options.systemConfig.leaseIdleTtl }),
		openClawRuntimeStatusStore,
		resolveGatewayEpoch: (expected) => ownershipCoordinator.resolveGatewayEpoch(expected),
		secretResolver,
		systemConfig: options.systemConfig,
	});
	const gatewayControlLeaseRpc = createGatewayControlLeaseRpcOperations({
		leaseManager,
		...(dependencies.onLeaseCreateRequest
			? { onLeaseCreateRequest: dependencies.onLeaseCreateRequest }
			: {}),
		...(dependencies.readIdentityPem ? { readIdentityPem: dependencies.readIdentityPem } : {}),
		recordHealthEvent: (event) => {
			healthEventStore.record(event);
		},
		resolveLeaseCreateOptions: async ({ callerContext, payload }) =>
			await resolveOpenClawToolVmLeaseCreateOptions({
				authorityContext: callerContext,
				requestedIdleTtlMs: payload.idleTtlHintMs,
			}),
	});
	const createOpenClawGatewayVmOwnership = async (ownershipOptions: {
		readonly controlIdentity?: { readonly bootId: string; readonly generationId: string };
		readonly kind: 'gateway-epoch' | 'standalone';
		readonly sessionLabel: string;
		readonly zoneId: string;
	}): Promise<VmCreationOwnership> => {
		if (
			ownershipOptions.kind !== 'gateway-epoch' ||
			ownershipOptions.controlIdentity === undefined
		) {
			throw new Error(
				`OpenClaw zone '${ownershipOptions.zoneId}' requires one Gateway epoch identity before VM creation.`,
			);
		}
		return await createGatewayVmCreationOwnership({
			bootId: ownershipOptions.controlIdentity.bootId,
			destructionBudget: gatewayDestructionBudget,
			destroyGatewayOwnedLeases: async (gatewayIdentity, signal) =>
				await leaseManager.destroyGatewayOwnedLeases(gatewayIdentity, signal),
			generationId: ownershipOptions.controlIdentity.generationId,
			ownershipCoordinator,
			sessionLabel: ownershipOptions.sessionLabel,
			zoneId: ownershipOptions.zoneId,
		});
	};
	const pushZoneGitFromController = async (
		zoneId: string,
		input: { readonly expectedHead: string },
	): Promise<Awaited<ReturnType<typeof pushZoneGit>>> =>
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
		);
	const runControllerHostProbe = async (): Promise<{
		readonly entryNames: string[];
		readonly probeKind: 'controller_cache_dir_listing';
	}> => {
		const probeDirectory = path.join(options.systemConfig.cacheDir, 'controller-host-probe');
		await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
		await writeFile(
			path.join(probeDirectory, controllerHostProbeMarkerFileName),
			'controller host probe\n',
			{ encoding: 'utf8', mode: 0o600 },
		);
		const entryNames = (await readdir(probeDirectory)).toSorted();
		return {
			entryNames,
			probeKind: 'controller_cache_dir_listing',
		};
	};
	const gatewayControlControllerHostActions: GatewayControlControllerHostActionOperations = {
		authorizeControllerHostAction: async ({ callerContext, payload, session }) =>
			await authorizeGatewayControlControllerHostAction({
				callerContext,
				payload,
				session,
				systemConfig: options.systemConfig,
			}),
		pushZoneGit: async ({ payload, session }) => {
			const result = await pushZoneGitFromController(session.zoneId, {
				expectedHead: payload.expectedHead,
			});
			return {
				branch: result.branch,
				localHead: result.localHead,
				pushedCommits: result.pushedCommits.map((commit) => ({
					sha: commit.sha,
					subject: commit.subject,
				})),
				remoteHead: result.remoteHead,
			};
		},
		runControllerHostProbe: async () => await runControllerHostProbe(),
	};
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
	const registry = createZoneRuntimeRegistry({
		createRuntimeForZone: (zone) =>
			isOpenClawZone(zone)
				? createOpenClawZoneRuntime({
						...(dependencies.deleteGatewayRuntimeRecord
							? { deleteGatewayRuntimeRecord: dependencies.deleteGatewayRuntimeRecord }
							: {}),
						createFreshSecretResolver,
						createVmOwnership: createOpenClawGatewayVmOwnership,
						...(dependencies.isProcessAlive ? { isProcessAlive: dependencies.isProcessAlive } : {}),
						now,
						preflightGatewayZoneStart: async (preflightOptions, preflightDependencies) => {
							const runtimeEnvironment = {
								...preflightOptions.runtimeEnvironment,
							};
							const runtimePluginConfigs = {
								...preflightOptions.runtimePluginConfigs,
							};
							const effectivePreflightDependencies =
								dependencies.checkObservabilityStackReadiness === undefined
									? preflightDependencies
									: {
											...preflightDependencies,
											checkObservabilityStackReadiness:
												dependencies.checkObservabilityStackReadiness,
										};
							return await (
								dependencies.preflightGatewayZoneStart ?? preflightGatewayZoneStartDefault
							)(
								{
									...preflightOptions,
									controlSession: { controllerEpoch },
									runtimeEnvironment,
									runtimePluginConfigs,
									writeLog: writeControllerRuntimeLog,
								},
								effectivePreflightDependencies,
							);
						},
						restartGatewayZone: async (zoneId, startOptions) => {
							const startGatewayZoneOptions = {
								controlSession: { controllerEpoch },
								createVmOwnership: createOpenClawGatewayVmOwnership,
								...(startOptions?.onPendingVmCreation
									? { onPendingVmCreation: startOptions.onPendingVmCreation }
									: {}),
								...(startOptions?.observabilityStartupCheck
									? { observabilityStartupCheck: startOptions.observabilityStartupCheck }
									: {}),
								...(startOptions?.prebuiltImage
									? { prebuiltImage: startOptions.prebuiltImage }
									: {}),
								runTask: runTaskStep,
								gatewayControlControllerHostActions,
								gatewayControlLeaseRpc,
								gatewayControlProcessAdmissionCoordinator,
								healthEventStore,
								openClawRuntimeStatusStore,
								runtimeEnvironment: {
									...startOptions?.runtimeEnvironment,
								},
								runtimePluginConfigs: {
									...startOptions?.runtimePluginConfigs,
								},
								secretResolver: startOptions?.secretResolver ?? secretResolver,
								systemConfig: options.systemConfig,
								writeLog: writeControllerRuntimeLog,
								zoneId,
							};
							if (dependencies.checkObservabilityStackReadiness === undefined) {
								return await (dependencies.startGatewayZone ?? startGatewayZone)(
									startGatewayZoneOptions,
								);
							}
							return await (dependencies.startGatewayZone ?? startGatewayZone)(
								startGatewayZoneOptions,
								{
									checkObservabilityStackReadiness: dependencies.checkObservabilityStackReadiness,
								},
							);
						},
						secretResolver,
						systemConfig: options.systemConfig,
						zone,
					})
				: isWorkerZone(zone)
					? createWorkerZoneRuntime({
							activeTaskRegistry,
							...(process.env.CALLER_URL ? { callerUrl: process.env.CALLER_URL } : {}),
							controllerEpoch,
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
			(dependencies.setTimeoutImpl ?? setTimeout)(() => {
				void serverRef.current?.close().catch((error: unknown) => {
					writeControllerRuntimeLog(
						`Failed to close controller HTTP server after stop request: ${formatUnknownError(error)}`,
					);
				});
			}, 100);
		},
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
						const currentToolVmLeases: ToolVmStatusLeaseView[] = leaseManager
							.listLeases()
							.filter((lease) => lease.zoneId === zoneId)
							.map(
								(lease) =>
									({
										effectiveIdleTtlMs: lease.effectiveIdleTtlMs,
										id: lease.id,
										lastUsedAt: lease.lastUsedAt,
										zoneId: lease.zoneId,
									}) satisfies ToolVmStatusLeaseView,
							);
						const currentToolVmActiveUses: ToolVmStatusActiveUseView[] =
							currentToolVmLeases.flatMap((lease) =>
								leaseManager.getActiveUses(lease.id).map(
									(activeUse) =>
										({
											expiresAt: activeUse.expiresAt,
											leaseId: activeUse.leaseId,
											useId: activeUse.useId,
										}) satisfies ToolVmStatusActiveUseView,
								),
							);
						const latestChannelProviderEvents = latestHealthEvents.filter(
							(
								event,
							): event is Extract<
								AgentVmHealthEvent,
								{ readonly kind: 'agent-channel-provider-health' }
							> => event.kind === 'agent-channel-provider-health',
						);
						const latestGatewayRuntimeHealthEvents = latestHealthEvents.filter(
							(event) =>
								event.kind === 'gateway-control-session' || event.kind === 'gateway-service-health',
						);
						const channelProviderPlane =
							latestChannelProviderEvents.length === 0
								? diagnosis.channelProviderPlane
								: aggregateChannelProviderPlane(latestChannelProviderEvents, {
										nowMs,
										staleAfterMs: controllerHealthConfig.staleAfterMs,
									});
						const toolVmStatus = classifyLifecycleAwareToolVmStatus({
							activeUses: currentToolVmActiveUses,
							events: latestHealthEvents,
							leases: currentToolVmLeases,
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
									toolVmPlane: toolVmStatus.plane,
								}),
								toolVmLeaseState: toolVmStatus.leaseState,
								toolVmPlane: toolVmStatus.plane,
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
			await pushZoneGitFromController(zoneId, input),
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
		now,
		...(dependencies.onLeaseCreateRequest
			? { onLeaseCreateRequest: dependencies.onLeaseCreateRequest }
			: {}),
		openClawRuntimeStatusStore,
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
	const observabilityStartupCheck = selectConfiguredObservabilityStartupCheck({
		systemConfig: options.systemConfig,
		...(options.zoneIds ? { zoneIds: options.zoneIds } : {}),
	});
	const checkObservabilityStackReadiness =
		dependencies.checkObservabilityStackReadiness ?? checkObservabilityStackReadinessDefault;
	if (
		observabilityStartupCheck?.enabled === true &&
		observabilityStartupCheck.controllerStartPolicy !== 'require-ready'
	) {
		void assertObservabilityStackReady({
			checkObservabilityStackReadiness,
			config: observabilityStartupCheck,
		})
			.then(() => {
				writeControllerRuntimeLog('Host observability stack is ready.');
			})
			.catch((error: unknown) => {
				writeControllerRuntimeLog(
					`Host observability stack degraded: ${formatUnknownError(error)}`,
				);
			});
	}
	try {
		if (
			observabilityStartupCheck?.enabled === true &&
			observabilityStartupCheck.controllerStartPolicy === 'require-ready'
		) {
			await runTaskStep('Checking host observability stack', async () => {
				await assertObservabilityStackReady({
					checkObservabilityStackReadiness,
					config: observabilityStartupCheck,
				});
			});
		}
		await runTaskStep('Starting selected gateway zones', async () => {
			await registry.startSelectedZones();
		});
		runtimeReadiness.set('ready');
		controllerTelemetry?.recordControllerLifecycleEvent({
			eventName: 'controller-started',
			observedAtMs: now(),
		});
	} catch (error) {
		runtimeReadiness.set('stopping');
		controllerTelemetry?.recordControllerLifecycleEvent({
			eventName: 'controller-start-failed',
			observedAtMs: now(),
		});
		try {
			await serverRef.current?.close();
		} finally {
			await healthEventStore.flushHealthEventSinks();
			await flushControllerTelemetry(controllerTelemetry);
			await shutdownControllerTelemetry(controllerTelemetry);
		}
		throw error;
	}

	await reapToolVmLeases();

	const gatewayServiceHealthMonitor = controllerHealthConfig.enabled
		? createGatewayServiceHealthMonitor({
				...(dependencies.clearIntervalImpl
					? { clearIntervalImpl: dependencies.clearIntervalImpl }
					: {}),
				controlSessionDeathGraceMs: controllerHealthConfig.controlSessionDeathGraceMs,
				gatewayServiceAutoRestart: controllerHealthConfig.gatewayServiceAutoRestart,
				healthEventStore,
				classifyRecoveryBudgetClass,
				intervalMs: controllerHealthConfig.gatewayServiceIntervalMs,
				now,
				probeZoneHealth: async (zoneId) => {
					const health = await operations.getZoneServiceHealth(zoneId);
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
				resolveGatewayRecoverySourceKey: ({ zoneId }) => {
					try {
						const lifecycleState = registry.getOpenClawRuntime(zoneId).getLifecycleState();
						if (lifecycleState.kind === 'running' || lifecycleState.kind === 'running-degraded') {
							return lifecycleState.gateway.controlSessionRecoverySourceKey;
						}
					} catch (error) {
						writeControllerRuntimeLog(
							`Gateway recovery source key resolution failed for zone '${zoneId}': ${formatUnknownError(error)}`,
						);
					}
					return undefined;
				},
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
			controllerTelemetry?.recordControllerLifecycleEvent({
				eventName: 'controller-stopping',
				observedAtMs: now(),
			});
			clearReaperTimer();
			await gatewayServiceHealthMonitor?.stop();
			requestHeartbeatRegistry.stopAll();
			let stopError: Error | undefined;
			let serverCloseError: Error | undefined;
			try {
				await registry.stopAllZones();
			} catch (error) {
				stopError = error instanceof Error ? error : new Error(formatUnknownError(error));
			} finally {
				try {
					await serverRef.current?.close();
				} catch (error) {
					serverCloseError = error instanceof Error ? error : new Error(formatUnknownError(error));
				}
				await healthEventStore.flushDurableWrites();
				await healthEventStore.flushHealthEventSinks();
				await flushControllerTelemetry(controllerTelemetry);
				await shutdownControllerTelemetry(controllerTelemetry);
			}
			const closeErrors = [stopError, serverCloseError].filter(
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

export async function startControllerRuntime(
	options: StartControllerRuntimeOptions,
	dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
	const controllerOwnershipLock = await (
		dependencies.acquireControllerOwnershipLock ?? acquireControllerOwnershipLockDefault
	)({ runtimeDirectory: options.systemConfig.runtimeDir });
	let runtime: ControllerRuntime;
	try {
		runtime = await startControllerRuntimeWithOwnershipLock(options, dependencies);
	} catch (startupError) {
		const retainOwnershipLock = containsGatewayOwnershipCoordinatorErrorCode(
			startupError,
			'owner-unsafe',
		);
		if (!retainOwnershipLock) {
			try {
				await controllerOwnershipLock.release();
			} catch (releaseError) {
				// oxlint-disable-next-line preserve-caught-error -- AggregateError.errors preserves releaseError while cause retains the primary startup failure.
				throw new AggregateError(
					[startupError, releaseError],
					'Controller startup and ownership lock release both failed',
					{ cause: startupError },
				);
			}
		}
		throw startupError;
	}
	return {
		...runtime,
		async close(): Promise<void> {
			let closeError: unknown;
			try {
				await runtime.close();
			} catch (error) {
				closeError = error;
			}
			const retainOwnershipLock = containsGatewayOwnershipCoordinatorErrorCode(
				closeError,
				'owner-unsafe',
			);
			let releaseError: unknown;
			if (!retainOwnershipLock) {
				try {
					await controllerOwnershipLock.release();
				} catch (error) {
					releaseError = error;
				}
			}
			if (closeError !== undefined && releaseError !== undefined) {
				throw new AggregateError(
					[closeError, releaseError],
					'Controller shutdown and ownership lock release both failed',
					{ cause: closeError },
				);
			}
			if (closeError !== undefined) {
				throw closeError;
			}
			if (releaseError !== undefined) {
				throw releaseError;
			}
		},
	};
}
