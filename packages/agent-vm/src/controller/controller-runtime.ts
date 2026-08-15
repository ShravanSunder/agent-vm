import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GatewayRuntimeApprovalAuthorityContext } from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import { createSecretResolver as createOnePasswordSecretResolver } from '@agent-vm/secret-management';

import { resolveCliVersion } from '../cli/cli-version.js';
import { resolveControllerHealthConfig } from '../config/system-config.js';
import {
	preflightGatewayZoneStart as preflightGatewayZoneStartDefault,
	startGatewayZoneForController,
} from '../gateway/gateway-zone-orchestrator.js';
import type { GatewayControlSessionAttachmentGap } from '../gateway/gateway-zone-support.js';
import { resolveManagedAgentRootPaths } from '../gateway/managed-agent-root-storage.js';
import { controllerFixedGatewayRuntimeArtifactLimits } from '../gateway/managed-gateway-runtime-input-builders.js';
import { resolveControllerTelemetryIdentity as resolveControllerTelemetryIdentityDefault } from '../observability/controller-telemetry-identity.js';
import {
	createGatewayTelemetryResourceAttributesEnvironmentValue,
	OTEL_RESOURCE_ATTRIBUTES_ENVIRONMENT_VARIABLE,
	startControllerTelemetry as startControllerTelemetryDefault,
	type ControllerTelemetry,
	type ControllerTelemetryProofAttributes,
} from '../observability/controller-telemetry.js';
import {
	createObservabilityRuntimeConfig,
	type EnabledObservabilityRuntimeConfig,
} from '../observability/observability-config.js';
import { checkObservabilityStackReadiness as checkObservabilityStackReadinessDefault } from '../observability/observability-readiness.js';
import { reconcileRecordedVmTree as reconcileRecordedVmTreeDefault } from '../operations/controller-offline-cleanup.js';
import { runTaskWithResult } from '../shared/run-task.js';
import { createUnstartedToolVm, type ToolVmRootBinding } from '../tool-vm/tool-vm-lifecycle.js';
import { ActiveTaskRegistry } from './active-task-registry.js';
import { createControllerApprovalBearerAuthenticator } from './approval/controller-approval-authentication.js';
import { createControllerApprovalLedger } from './approval/controller-approval-ledger.js';
import { authorizeGatewayControlControllerHostAction } from './control-session/gateway-control-controller-host-action-authorization.js';
import type { GatewayControlControllerHostActionOperations } from './control-session/gateway-control-domain-handler.js';
import {
	createGatewayControlLeaseRpcOperations,
	createGatewayControlProcessAdmissionCoordinator,
} from './control-session/index.js';
import { writeControllerDiagnostic } from './controller-diagnostic-logging.js';
import type {
	ControllerDiagnosticLevel,
	ControllerDiagnosticTelemetry,
} from './controller-diagnostic-logging.js';
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
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
	type ControllerStateRoot,
} from './durable-state/controller-state-paths.js';
import {
	resolveControllerGatewayRecordTargets,
	resolveControllerWorkerTaskRuntimeRecordTarget,
	type ControllerGatewayRecordTargets,
} from './durable-state/controller-state-record-paths.js';
import type { PullDefaultRequest } from './git-pull-default-operations.js';
import type { PushBranchRequest } from './git-push-operations.js';
import { appendDurableHealthEvent } from './health/durable-health-event-log.js';
import { classifyGatewayRecoveryAction } from './health/gateway-recovery-actions.js';
import {
	createGatewayServiceHealthMonitor,
	type GatewayServiceHealthMonitor,
} from './health/gateway-service-health-monitor.js';
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
import { createManagedFrameworkToolVmLeaseCreateOptionsResolver } from './leases/managed-framework-tool-vm-lease-create-options.js';
import { createTcpPool } from './leases/tcp-pool.js';
import { OpenClawRuntimeStatusStore } from './openclaw-runtime-status.js';
import { RequestHeartbeatRegistry } from './request-heartbeat-registry.js';
import { acquireControllerOwnershipLock as acquireControllerOwnershipLockDefault } from './vm-ownership/controller-ownership-lock.js';
import { createGatewayDestructionBudget } from './vm-ownership/gateway-destruction-budget.js';
import { createGatewayOwnershipCoordinator } from './vm-ownership/gateway-ownership-coordinator.js';
import {
	containsGatewayOwnershipCoordinatorErrorCode,
	GatewayOwnershipCoordinatorError,
} from './vm-ownership/gateway-ownership-errors.js';
import {
	createGatewayVmLifecycleAuthority,
	type GatewayVmLifecycleAuthority,
} from './vm-ownership/gateway-vm-lifecycle-authority.js';
import { gatewayIdentitiesEqual } from './vm-ownership/vm-ownership-contracts.js';
import type { PreparedWorkerTask, WorkerTaskInput } from './worker-task-runner.js';
import { WorkspaceGitOperationLocks } from './workspace-git/workspace-git-operation-locks.js';
import {
	materializeWorkspaceGitRepository,
	pushWorkspaceGit,
	type WorkspaceGitRemoteOperationConfig,
} from './workspace-git/workspace-git-operations.js';
import type {
	GatewayChannelProviderPlane,
	GatewayDiagnosisSnapshot,
	GatewaySelectedZoneReadiness,
	GatewayToolVmPlane,
} from './zone-runtimes/gateway-zone-state-machine.js';
import {
	createManagedGatewayZoneRuntime,
	requireManagedGatewayStartResult,
} from './zone-runtimes/managed-gateway-zone-runtime.js';
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
const defaultApprovalChallengeTtlMs = 5 * 60 * 1_000;

type ControllerManagedToolVmOptions = Parameters<
	NonNullable<ControllerRuntimeDependencies['createManagedToolVm']>
>[0];

function resolveToolVmRootBinding(
	toolVmOptions: ControllerManagedToolVmOptions,
): ToolVmRootBinding {
	return {
		...(toolVmOptions.hostGitDirectoryRoot === undefined
			? {}
			: { hostGitDirectoryRoot: toolVmOptions.hostGitDirectoryRoot }),
		hostWorkspaceRoot: toolVmOptions.hostWorkspaceRoot,
		kind: 'managed-agent-workspace',
	};
}

function writeControllerRuntimeLog(
	level: ControllerDiagnosticLevel = 'warning',
	telemetry: ControllerDiagnosticTelemetry = { operation: 'controller-runtime-callback' },
): void {
	writeControllerDiagnostic(
		'runtime',
		level === 'warning'
			? { event: 'runtime-diagnostic', failureClass: 'failure', level, telemetry }
			: { event: 'runtime-diagnostic', level, telemetry },
	);
}

function writeControllerGatewayLog(
	level: ControllerDiagnosticLevel = 'warning',
	telemetry: ControllerDiagnosticTelemetry = { operation: 'gateway-runtime-callback' },
): void {
	writeControllerDiagnostic(
		'gateway',
		level === 'warning'
			? { event: 'gateway-health-diagnostic', failureClass: 'failure', level, telemetry }
			: { event: 'gateway-health-diagnostic', level, telemetry },
	);
}

function writeControllerGatewayRecoveryLog(
	level: ControllerDiagnosticLevel = 'warning',
	telemetry: ControllerDiagnosticTelemetry = { operation: 'gateway-recovery-callback' },
): void {
	writeControllerDiagnostic(
		'gateway',
		level === 'warning'
			? { event: 'gateway-recovery-diagnostic', failureClass: 'failure', level, telemetry }
			: { event: 'gateway-recovery-diagnostic', level, telemetry },
	);
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
	} catch {
		writeControllerRuntimeLog('warning', {
			operation: 'controller-telemetry-flush',
		});
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
	} catch {
		writeControllerRuntimeLog('warning', {
			operation: 'controller-telemetry-shutdown',
		});
	}
}

function isManagedGatewayZone(zone: ControllerZoneConfig): zone is ControllerZoneConfig & {
	readonly gateway: Extract<
		ControllerZoneConfig['gateway'],
		{ readonly type: 'hermes' | 'openclaw' }
	>;
} {
	return zone.gateway.type !== 'worker';
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

function resolveWorkspaceGitRemoteOperationConfig(options: {
	readonly agentId: string;
	readonly controllerGithubToken: string | null;
	readonly systemConfig: StartControllerRuntimeOptions['systemConfig'];
	readonly zoneId: string;
}): WorkspaceGitRemoteOperationConfig {
	let zone: ControllerZoneConfig;
	try {
		zone = findConfiguredZone(options.systemConfig, options.zoneId);
	} catch {
		throw new ControllerZoneNotFoundError(options.zoneId);
	}
	if (!isManagedGatewayZone(zone)) {
		throw new ControllerZoneOperationUnsupportedError(
			options.zoneId,
			'workspace Git operations',
			zone.gateway.type,
		);
	}
	const configuredAgent = (zone.agents ?? []).find((agent) => agent.id === options.agentId);
	if (configuredAgent?.workspaceGit?.mode !== 'remote') {
		throw new ControllerZoneConfigurationError(
			options.zoneId,
			`Agent '${options.agentId}' does not configure remote workspace Git.`,
		);
	}
	if (!options.controllerGithubToken) {
		throw new ControllerZoneConfigurationError(
			options.zoneId,
			`Remote workspace Git for zone '${options.zoneId}' requires host.githubToken so the controller can push without exposing credentials to VMs.`,
		);
	}
	return {
		agentId: configuredAgent.id,
		branch: configuredAgent.workspaceGit.remote.branch,
		defaultBranch: configuredAgent.workspaceGit.remote.defaultBranch,
		githubToken: options.controllerGithubToken,
		hostWorkspaceDirectory: resolveManagedAgentRootPaths({
			agentId: configuredAgent.id,
			zoneFilesDir: zone.gateway.zoneFilesDir,
		}).hostWorkspaceRoot,
		remoteUrl: configuredAgent.workspaceGit.remote.repoUrl,
		zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
		zoneId: options.zoneId,
	};
}

export function createGatewayRuntimeEnvironmentForZone(options: {
	readonly callerRuntimeEnvironment?: Readonly<Record<string, string>> | undefined;
	readonly controllerTelemetryRuntimeEnvironment: Readonly<Record<string, string>>;
	readonly zone: { readonly observability?: { readonly enabled: boolean } | undefined };
}): Readonly<Record<string, string>> {
	return {
		...options.callerRuntimeEnvironment,
		...(options.zone.observability?.enabled === true
			? options.controllerTelemetryRuntimeEnvironment
			: {}),
	};
}

async function startControllerRuntimeWithOwnershipLock(
	options: StartControllerRuntimeOptions,
	dependencies: ControllerRuntimeDependencies,
	controllerStateRoot: ControllerStateRoot,
): Promise<ControllerRuntime> {
	const now = dependencies.now ?? Date.now;
	const controllerEpoch = dependencies.controllerEpoch ?? randomUUID();
	const gatewayControlProcessAdmissionCoordinator =
		createGatewayControlProcessAdmissionCoordinator();
	const controllerGatewayRecordTargetsFor = (zoneId: string): ControllerGatewayRecordTargets => {
		findConfiguredZone(options.systemConfig, zoneId);
		return resolveControllerGatewayRecordTargets({
			gatewayStateRoot: resolveControllerGatewayStateRoot({ controllerStateRoot, zoneId }),
		});
	};
	const gatewayDestructionBudget = createGatewayDestructionBudget();
	const ownershipCoordinator = (
		dependencies.createGatewayOwnershipCoordinator ?? createGatewayOwnershipCoordinator
	)({
		controllerEpoch,
		createGatewayEpochId: randomUUID,
	});
	dependencies.configureManagedVmHostNetworkDefaults();
	writeControllerRuntimeLog('info', {
		operation: 'configure-host-network-defaults',
	});
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
	const authenticateApprovalBearer = await createControllerApprovalBearerAuthenticator({
		secretResolver,
		systemConfig: options.systemConfig,
	});
	const approvalLedgersByZoneId = new Map(
		options.systemConfig.zones.filter(isManagedGatewayZone).map(
			(zone) =>
				[
					zone.id,
					createControllerApprovalLedger({
						challengeTtlMs: defaultApprovalChallengeTtlMs,
						currentControllerEpoch: controllerEpoch,
						now,
						recordsTarget: controllerGatewayRecordTargetsFor(zone.id).approvalRecords,
					}),
				] as const,
		),
	);
	const controllerGithubToken = await resolveControllerGithubToken(
		options.systemConfig,
		secretResolver,
	);
	const createManagedToolVm = async (
		toolVmOptions: ControllerManagedToolVmOptions,
	): Promise<
		Awaited<ReturnType<NonNullable<ControllerRuntimeDependencies['createManagedToolVm']>>>
	> => {
		if (dependencies.createManagedToolVm !== undefined) {
			return await dependencies.createManagedToolVm(toolVmOptions);
		}
		return await createUnstartedToolVm(
			{
				agentId: toolVmOptions.agentId,
				cacheDir: options.systemConfig.cacheDir,
				profile: toolVmOptions.profile,
				systemConfig: options.systemConfig,
				tcpSlot: toolVmOptions.tcpSlot,
				rootBinding: resolveToolVmRootBinding(toolVmOptions),
				zoneId: toolVmOptions.zoneId,
				secretResolver: toolVmOptions.secretResolver,
			},
			{
				managedVmFactory: dependencies.managedVmFactory,
				managedVmImages: dependencies.managedVmImages,
				managedVmOwnedDirectories: dependencies.managedVmOwnedDirectories,
			},
		);
	};
	const tcpPool = createTcpPool(options.systemConfig.tcpPool);
	const activeTaskRegistry = new ActiveTaskRegistry();
	const requestHeartbeatRegistry = new RequestHeartbeatRegistry();
	const workspaceGitOperationLocks =
		dependencies.workspaceGitOperationLocks ?? new WorkspaceGitOperationLocks();
	const materializeWorkspaceGit =
		dependencies.materializeWorkspaceGitRepository ?? materializeWorkspaceGitRepository;
	const controllerHealthConfig = resolveControllerHealthConfig(options.systemConfig);
	const observabilityRuntimeConfig = createObservabilityRuntimeConfig(options.systemConfig);
	let controllerTelemetry: ControllerTelemetry | undefined;
	let gatewayTelemetryRuntimeEnvironment: Readonly<Record<string, string>> = {};
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
			gatewayTelemetryRuntimeEnvironment = Object.freeze({
				[OTEL_RESOURCE_ATTRIBUTES_ENVIRONMENT_VARIABLE]:
					createGatewayTelemetryResourceAttributesEnvironmentValue({
						identity,
						projectNamespace: options.systemConfig.host.projectNamespace,
						stackMode: observabilityRuntimeConfig.stackMode,
					}),
			});
			controllerTelemetry = (
				dependencies.startControllerTelemetry ?? startControllerTelemetryDefault
			)({
				identity,
				observabilityConfig: observabilityRuntimeConfig,
				projectNamespace: options.systemConfig.host.projectNamespace,
				proof: createControllerTelemetryProofAttributes(),
			});
		} catch {
			writeControllerRuntimeLog('warning', {
				operation: 'start-controller-telemetry',
			});
		}
	}
	const healthEventStore = new HealthEventStore({
		durableEventLog: {
			append: async (event) => {
				await (dependencies.appendDurableHealthEvent ?? appendDurableHealthEvent)({
					controllerPid: process.pid,
					controllerPort: options.systemConfig.host.controllerPort,
					event,
					controllerRuntimeDir: options.systemConfig.controllerRuntimeDir,
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
				...(leaseOptions.hostGitDirectoryRoot === undefined
					? {}
					: { hostGitDirectoryRoot: leaseOptions.hostGitDirectoryRoot }),
				profile: leaseOptions.profile,
				tcpSlot: leaseOptions.tcpSlot,
				hostWorkspaceRoot: leaseOptions.hostWorkspaceRoot,
				zoneId: leaseOptions.zoneId,
				secretResolver,
			}),
		now,
		managedVmExactProcessTermination: dependencies.managedVmExactProcessTermination,
		ownershipCoordinator,
		prepareLeasePersistentState: async (leaseOptions): Promise<void> => {
			const zone = findConfiguredZone(options.systemConfig, leaseOptions.zoneId);
			if (!isManagedGatewayZone(zone)) {
				throw new ControllerZoneOperationUnsupportedError(
					leaseOptions.zoneId,
					'managed Tool VM persistent-state preparation',
					zone.gateway.type,
				);
			}
			const configuredAgent = (zone.agents ?? []).find(
				(agent) => agent.id === leaseOptions.agentId,
			);
			if (configuredAgent === undefined) {
				throw new ControllerZoneConfigurationError(
					leaseOptions.zoneId,
					`Agent '${leaseOptions.agentId}' is not configured for persistent-state preparation.`,
				);
			}
			if (configuredAgent.workspaceGit === undefined) {
				return;
			}
			await materializeWorkspaceGit({
				agentId: configuredAgent.id,
				hostWorkspaceDirectory: leaseOptions.hostWorkspaceRoot,
				policy:
					configuredAgent.workspaceGit.mode === 'local'
						? { kind: 'local' }
						: {
								branch: configuredAgent.workspaceGit.remote.branch,
								kind: 'remote',
								remoteUrl: configuredAgent.workspaceGit.remote.repoUrl,
							},
				zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
				zoneId: leaseOptions.zoneId,
			});
		},
		projectNamespace: options.systemConfig.host.projectNamespace,
		...(dependencies.readProcessIdentity !== undefined
			? { readProcessIdentity: dependencies.readProcessIdentity }
			: {}),
		systemConfigPath: options.systemConfig.systemConfigPath,
		tcpPool,
		toolLeaseRecordsTargetFor: (zoneId) =>
			controllerGatewayRecordTargetsFor(zoneId).toolLeaseRecords,
	});
	const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore({ nowMs: now });
	const resolveManagedFrameworkToolVmLeaseCreateOptions =
		createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			...(options.systemConfig.leaseIdleTtl === undefined
				? {}
				: { leaseIdleTtlPolicy: options.systemConfig.leaseIdleTtl }),
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
		resolveLeaseCreateOptions: async ({ callerContext, gateway, payload }) =>
			await resolveManagedFrameworkToolVmLeaseCreateOptions({
				authorityContext: callerContext,
				expectedGateway: gateway,
				requestedIdleTtlMs: payload.idleTtlHintMs,
			}),
	});
	const createManagedGatewayVmOwnership = async (ownershipOptions: {
		readonly controlIdentity?: { readonly bootId: string; readonly generationId: string };
		readonly kind: 'gateway-epoch' | 'standalone';
		readonly sessionLabel: string;
		readonly zoneId: string;
	}): Promise<GatewayVmLifecycleAuthority> => {
		if (
			ownershipOptions.kind !== 'gateway-epoch' ||
			ownershipOptions.controlIdentity === undefined
		) {
			throw new Error(
				`Managed Gateway zone '${ownershipOptions.zoneId}' requires one Gateway epoch identity before VM creation.`,
			);
		}
		return createGatewayVmLifecycleAuthority({
			bootId: ownershipOptions.controlIdentity.bootId,
			destructionBudget: gatewayDestructionBudget,
			destroyGatewayOwnedLeases: async (gatewayIdentity, signal) =>
				await leaseManager.destroyGatewayOwnedLeases(gatewayIdentity, signal),
			generationId: ownershipOptions.controlIdentity.generationId,
			ownershipCoordinator,
			zoneId: ownershipOptions.zoneId,
		});
	};
	const pushWorkspaceGitFromController = async (
		agentId: string,
		zoneId: string,
		input: { readonly expectedHead: string },
	): Promise<Awaited<ReturnType<typeof pushWorkspaceGit>>> =>
		await workspaceGitOperationLocks.runExclusive(
			{ agentId, resourceKind: 'workspace', zoneId },
			async () =>
				await pushWorkspaceGit({
					...resolveWorkspaceGitRemoteOperationConfig({
						agentId,
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
		pushWorkspaceGit: async ({ callerContext, payload, session }) => {
			const result = await pushWorkspaceGitFromController(callerContext.agentId, session.zoneId, {
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
			reapToolVmLeases().catch(() =>
				writeControllerRuntimeLog('warning', {
					operation: 'reap-tool-vm-leases',
				}),
			),
		60_000,
	);
	const clearReaperTimer = (): void =>
		(dependencies.clearIntervalImpl ?? clearInterval)(reaperTimer);
	const gatewayServiceHealthMonitorRef: { current?: GatewayServiceHealthMonitor | undefined } = {};
	const registry = createZoneRuntimeRegistry({
		createRuntimeForZone: (zone) =>
			isManagedGatewayZone(zone)
				? createManagedGatewayZoneRuntime({
						createFreshSecretResolver,
						createVmOwnership: createManagedGatewayVmOwnership,
						...(options.prebuiltGatewayImages?.[zone.id] === undefined
							? {}
							: { initialPrebuiltImage: options.prebuiltGatewayImages[zone.id] }),
						managedVmFactory: dependencies.managedVmFactory,
						managedVmExactProcessTermination: dependencies.managedVmExactProcessTermination,
						managedVmImages: dependencies.managedVmImages,
						managedVmOwnedDirectories: dependencies.managedVmOwnedDirectories,
						recordCurrentControlSessionHealthEvent: (event) => healthEventStore.record(event),
						recordCurrentControlSessionLiveHealthEvent: (event) =>
							healthEventStore.recordLiveOnly(event),
						recordNonCurrentControlSessionEvidence: (event) =>
							healthEventStore.recordEvidenceOnly(event),
						...(dependencies.isProcessAlive ? { isProcessAlive: dependencies.isProcessAlive } : {}),
						now,
						onGatewayRuntimeAttachmentLost: (transition) => {
							let lifecycleState;
							try {
								lifecycleState = registry
									.getManagedGatewayRuntime(transition.gateway.zoneId)
									.getLifecycleState();
							} catch {
								writeControllerRuntimeLog('warning', {
									operation: 'resolve-gateway-runtime-for-attachment-loss',
									zoneId: transition.gateway.zoneId,
								});
								return;
							}
							if (
								(lifecycleState.kind !== 'running' && lifecycleState.kind !== 'running-degraded') ||
								!gatewayIdentitiesEqual(lifecycleState.gateway.gatewayIdentity, transition.gateway)
							) {
								return;
							}
							const gatewayIdentity = lifecycleState.gateway.gatewayIdentity;
							void gatewayServiceHealthMonitorRef.current
								?.recoverFromTerminalAttachmentLoss({
									sourceKey: {
										bootId: gatewayIdentity.bootId,
										domain: 'gateway_control',
										gatewayVmId: gatewayIdentity.gatewayVmId,
										generationId: gatewayIdentity.generationId,
										zoneId: gatewayIdentity.zoneId,
									},
									zoneId: gatewayIdentity.zoneId,
								})
								.catch(() => {
									writeControllerRuntimeLog('warning', {
										operation: 'recover-gateway-runtime-attachment-loss',
										zoneId: gatewayIdentity.zoneId,
									});
								});
						},
						preflightGatewayZoneStart: async (preflightOptions, preflightDependencies) => {
							const runtimeEnvironment = createGatewayRuntimeEnvironmentForZone({
								callerRuntimeEnvironment: preflightOptions.runtimeEnvironment,
								controllerTelemetryRuntimeEnvironment: gatewayTelemetryRuntimeEnvironment,
								zone,
							});
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
									writeLog: writeControllerGatewayLog,
								},
								{
									...effectivePreflightDependencies,
									managedVmImages: dependencies.managedVmImages,
								},
							);
						},
						restartGatewayZone: async (zoneId, startOptions) => {
							const approvalLedger = approvalLedgersByZoneId.get(zoneId);
							if (approvalLedger === undefined) {
								throw new Error(
									`Managed Gateway zone '${zoneId}' does not have an approval ledger.`,
								);
							}
							const startGatewayZoneOptions = {
								controlSession: { controllerEpoch },
								createVmOwnership: createManagedGatewayVmOwnership,
								...(startOptions?.onPendingVmCreation
									? { onPendingVmCreation: startOptions.onPendingVmCreation }
									: {}),
								...(startOptions?.onControlSessionReconnectExhausted
									? {
											onControlSessionReconnectExhausted:
												startOptions.onControlSessionReconnectExhausted,
										}
									: {}),
								...(startOptions?.onControlSessionHeartbeat
									? { onControlSessionHeartbeat: startOptions.onControlSessionHeartbeat }
									: {}),
								...(startOptions?.onControlSessionHealthEvidence
									? {
											onControlSessionHealthEvidence: startOptions.onControlSessionHealthEvidence,
										}
									: {}),
								onControlSessionAttachmentGap: (transition: GatewayControlSessionAttachmentGap) => {
									leaseManager.markControlSessionDisconnected({
										gateway: transition.gateway,
										observedAtMs: transition.observedAtMs,
										processEpoch: transition.processEpoch,
										sessionAttachmentGeneration: transition.attachmentGeneration,
									});
								},
								...(startOptions?.onGatewayRuntimeAttachmentLost
									? {
											onGatewayRuntimeAttachmentLost: startOptions.onGatewayRuntimeAttachmentLost,
										}
									: {}),
								...(startOptions?.observabilityStartupCheck
									? { observabilityStartupCheck: startOptions.observabilityStartupCheck }
									: {}),
								...(startOptions?.prebuiltImage
									? { prebuiltImage: startOptions.prebuiltImage }
									: {}),
								runTask: runTaskStep,
								gatewayControlControllerHostActions,
								gatewayControlApprovalLedger: approvalLedger,
								gatewayControlBindingPublicationSource: gatewayControlLeaseRpc,
								gatewayControlLeaseRpc,
								gatewayControlProcessAdmissionCoordinator,
								healthEventStore,
								...(zone.gateway.type === 'openclaw' ? { openClawRuntimeStatusStore } : {}),
								runtimeEnvironment: createGatewayRuntimeEnvironmentForZone({
									callerRuntimeEnvironment: startOptions?.runtimeEnvironment,
									controllerTelemetryRuntimeEnvironment: gatewayTelemetryRuntimeEnvironment,
									zone,
								}),
								runtimePluginConfigs: {
									...startOptions?.runtimePluginConfigs,
								},
								runtimeRecordTarget:
									controllerGatewayRecordTargetsFor(zoneId).managedGatewayRuntimeRecord,
								secretResolver: startOptions?.secretResolver ?? secretResolver,
								systemConfig: options.systemConfig,
								writeLog: writeControllerGatewayLog,
								zoneId,
							};
							if (dependencies.checkObservabilityStackReadiness === undefined) {
								return await requireManagedGatewayStartResult(
									await (dependencies.startGatewayZone ?? startGatewayZoneForController)(
										startGatewayZoneOptions,
										{
											gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
											managedVmFactory: dependencies.managedVmFactory,
											managedVmExactProcessTermination:
												dependencies.managedVmExactProcessTermination,
											managedVmImages: dependencies.managedVmImages,
											managedVmOwnedDirectories: dependencies.managedVmOwnedDirectories,
										},
									),
								);
							}
							return await requireManagedGatewayStartResult(
								await (dependencies.startGatewayZone ?? startGatewayZoneForController)(
									startGatewayZoneOptions,
									{
										checkObservabilityStackReadiness: dependencies.checkObservabilityStackReadiness,
										gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
										managedVmFactory: dependencies.managedVmFactory,
										managedVmExactProcessTermination: dependencies.managedVmExactProcessTermination,
										managedVmImages: dependencies.managedVmImages,
										managedVmOwnedDirectories: dependencies.managedVmOwnedDirectories,
									},
								),
							);
						},
						runtimeRecordTarget: controllerGatewayRecordTargetsFor(zone.id)
							.managedGatewayRuntimeRecord,
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
							managedVmFactory: dependencies.managedVmFactory,
							managedVmExactProcessTermination: dependencies.managedVmExactProcessTermination,
							managedVmImages: dependencies.managedVmImages,
							secretResolver,
							systemConfig: options.systemConfig,
							workerRuntimeRecordTargetFor: (taskId) =>
								resolveControllerWorkerTaskRuntimeRecordTarget({
									gatewayStateRoot: resolveControllerGatewayStateRoot({
										controllerStateRoot,
										zoneId: zone.id,
									}),
									taskId,
								}),
							zone,
						})
					: (() => {
							throw new Error(`Unsupported gateway type for zone '${zone.id}'.`);
						})(),
		...(options.startupFailures ? { startupFailures: options.startupFailures } : {}),
		systemConfig: options.systemConfig,
		writeLog: writeControllerGatewayLog,
		...(options.zoneIds ? { zoneIds: options.zoneIds } : {}),
	});

	const serverRef: { current?: { close(): Promise<void> } } = {};
	const runtimeReadiness = createMutableControllerRuntimeReadiness('recovering');
	const stopController = createStopControllerOperation({
		clearReaperTimer,
		closeControllerServer: async () => {
			(dependencies.setTimeoutImpl ?? setTimeout)(() => {
				void serverRef.current?.close().catch(() => {
					writeControllerRuntimeLog('warning', {
						operation: 'close-controller-http-server',
					});
				});
			}, 100);
		},
		stopAllZones: async () => await registry.stopAllZones(),
	});
	const operations = {
		...createControllerRuntimeOperations({
			destroyZoneRuntime: async (zoneId, purge) => await registry.destroyZone(zoneId, purge),
			getActiveLeases: () => leaseManager.listLeases(),
			getObservabilityStatus: () => ({
				evidence: healthEventStore.getEvidenceQueueDiagnostics(),
				...(controllerTelemetry?.getDiagnostics === undefined
					? {}
					: { telemetry: controllerTelemetry.getDiagnostics() }),
			}),
			getManagedGatewayRuntime: (zoneId) => registry.getManagedGatewayRuntime(zoneId),
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
		prepareWorkerTask: async (zoneId: string, input: WorkerTaskInput) =>
			await registry.getWorkerRuntime(zoneId).prepareWorkerTask(input),
		pullDefaultForTask: async (zoneId: string, taskId: string, input: PullDefaultRequest) =>
			await registry.getWorkerRuntime(zoneId).pullDefaultForTask(taskId, input),
		pushTaskBranches: async (
			zoneId: string,
			taskId: string,
			input: { readonly branches: readonly PushBranchRequest[] },
		) => await registry.getWorkerRuntime(zoneId).pushTaskBranches(taskId, input),
		stopController,
	};
	const recoverGatewayVm = createGatewayVmRecoveryRunner({
		getRecoverableGatewayRuntime: (zoneId) => registry.getManagedGatewayRuntime(zoneId),
		getRuntimeReadiness: () => runtimeReadiness.get(),
		now,
		restartTimeoutMs: controllerHealthConfig.gatewayServiceAutoRestart.restartTimeoutMs,
		writeLog: writeControllerGatewayRecoveryLog,
	});
	const classifyRecoveryBudgetClass = (request: {
		readonly consecutiveFailures: number;
		readonly reason: GatewayVmRecoveryReason;
		readonly zoneId: string;
	}): GatewayVmRecoveryBudgetClass => {
		try {
			const runtime = registry.getManagedGatewayRuntime(request.zoneId);
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
		} catch {
			writeControllerRuntimeLog('warning', {
				operation: 'classify-gateway-vm-recovery-budget',
				zoneId: request.zoneId,
			});
			return 'gateway-vm-restart';
		}
	};
	const controllerApp = createControllerService({
		approvalRoutes: {
			authenticateBearer: authenticateApprovalBearer,
			readCurrentAuthorityContext: async (
				zoneId,
			): Promise<GatewayRuntimeApprovalAuthorityContext | null> => {
				let runtime;
				try {
					runtime = registry.getManagedGatewayRuntime(zoneId);
				} catch {
					return null;
				}
				const lifecycleState = runtime.getLifecycleState();
				if (lifecycleState.kind !== 'running' && lifecycleState.kind !== 'running-degraded') {
					return null;
				}
				const { gatewayIdentity } = lifecycleState.gateway;
				return {
					controllerEpoch: gatewayIdentity.controllerEpoch,
					frameworkEpoch: lifecycleState.gateway.expectedCohort.frameworkIdentity.frameworkEpoch,
					gatewayEpoch: gatewayIdentity.gatewayEpochId,
					runtimeEpoch: gatewayIdentity.generationId,
					zoneId: gatewayIdentity.zoneId,
				};
			},
			resolveLedger: (zoneId) => approvalLedgersByZoneId.get(zoneId) ?? null,
		},
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
				writeControllerRuntimeLog('info', {
					operation: 'check-host-observability-stack',
				});
			})
			.catch(() => {
				writeControllerRuntimeLog('warning', {
					operation: 'check-host-observability-stack',
				});
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

	gatewayServiceHealthMonitorRef.current = controllerHealthConfig.enabled
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
				recoverDeadControlSession: ({ sourceKey, zoneId }) => {
					registry.getManagedGatewayRuntime(zoneId).ensureCurrentControlSessionDialing(sourceKey);
					return Promise.resolve();
				},
				resolveGatewayRecoverySourceKey: ({ zoneId }) => {
					try {
						const lifecycleState = registry.getManagedGatewayRuntime(zoneId).getLifecycleState();
						if (lifecycleState.kind !== 'running' && lifecycleState.kind !== 'running-degraded') {
							return undefined;
						}
						const { gatewayIdentity } = lifecycleState.gateway;
						return {
							bootId: gatewayIdentity.bootId,
							domain: 'gateway_control',
							gatewayVmId: gatewayIdentity.gatewayVmId,
							generationId: gatewayIdentity.generationId,
							zoneId: gatewayIdentity.zoneId,
						};
					} catch {
						writeControllerRuntimeLog('warning', {
							operation: 'resolve-gateway-recovery-source-key',
							zoneId,
						});
						return undefined;
					}
				},
				...(dependencies.setIntervalImpl ? { setIntervalImpl: dependencies.setIntervalImpl } : {}),
				staleAfterMs: controllerHealthConfig.staleAfterMs,
				zoneIds: registry.selectedZoneIds.filter((zoneId) => {
					const zone = options.systemConfig.zones.find((candidate) => candidate.id === zoneId);
					return zone ? isManagedGatewayZone(zone) : false;
				}),
			})
		: undefined;
	gatewayServiceHealthMonitorRef.current?.start();

	const snapshotByZone = registry.getSnapshotByZone();
	return {
		async close(): Promise<void> {
			runtimeReadiness.set('stopping');
			controllerTelemetry?.recordControllerLifecycleEvent({
				eventName: 'controller-stopping',
				observedAtMs: now(),
			});
			clearReaperTimer();
			await gatewayServiceHealthMonitorRef.current?.stop();
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
	)({ runtimeDirectory: options.systemConfig.controllerRuntimeDir });
	const controllerStateRoot = createControllerStateRoot({
		controllerStateDirectoryPath: options.systemConfig.controllerStateDir,
	});
	let runtime: ControllerRuntime;
	try {
		const reconcileRecordedVmTree =
			dependencies.reconcileRecordedVmTree ?? reconcileRecordedVmTreeDefault;
		const selectedZoneIds = [
			...new Set(options.zoneIds ?? options.systemConfig.zones.map((zone) => zone.id)),
		];
		for (const zoneId of selectedZoneIds) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- Reconcile recorded VM trees sequentially so cleanup and owner-unsafe failures cannot race across zones during startup.
				await reconcileRecordedVmTree({
					controllerStateRoot,
					exactProcessTermination: dependencies.managedVmExactProcessTermination,
					systemConfig: options.systemConfig,
					zoneId,
				});
			} catch (error) {
				if (containsGatewayOwnershipCoordinatorErrorCode(error, 'owner-unsafe')) {
					throw error;
				}
				throw new GatewayOwnershipCoordinatorError('owner-unsafe', { cause: error });
			}
		}
		runtime = await startControllerRuntimeWithOwnershipLock(
			options,
			dependencies,
			controllerStateRoot,
		);
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
