import { randomUUID } from 'node:crypto';

import type { AgentVmHealthEvent, GatewayHealthCheck } from '@agent-vm/gateway-lifecycle';
import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmImageBuildResult,
	ManagedVmImageCapability,
	ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { runGatewayHealthCheck } from '../../gateway/gateway-health-check.js';
import { GatewayOwnershipUnsafeError } from '../../gateway/gateway-ownership-evidence.js';
import {
	preflightGatewayZoneStart as preflightGatewayZoneStartDefault,
	startGatewayZone,
} from '../../gateway/gateway-zone-orchestrator.js';
import type {
	GatewayControlSessionAttemptOutcome,
	GatewayControlSessionHeartbeat,
	GatewayControlSessionHealthEvidence,
	GatewayControlSessionReconnectExhausted,
	GatewayRuntimeAttachmentLost,
	GatewayZoneDestroyResult,
	GatewayZoneStartResult,
	ManagedGatewayZoneStartResult,
	PendingGatewayVmCreationContainment,
	StartGatewayZoneOptions as StartGatewayZoneRequestOptions,
} from '../../gateway/gateway-zone-support.js';
import { controllerFixedGatewayRuntimeArtifactLimits } from '../../gateway/managed-gateway-runtime-input-builders.js';
import { runControllerCredentialsRefresh as runControllerCredentialsRefreshDefault } from '../../operations/credentials-refresh.js';
import { runControllerDestroy as runControllerDestroyDefault } from '../../operations/destroy-zone.js';
import { runControllerUpgrade as runControllerUpgradeDefault } from '../../operations/upgrade-zone.js';
import { runControllerLogs as runControllerLogsDefault } from '../../operations/zone-logs.js';
import { isProcessAlive as defaultIsProcessAlive } from '../../shared/managed-vm-process.js';
import { writeControllerDiagnostic } from '../controller-diagnostic-logging.js';
import type { ControllerManagedGatewayRuntimeRecordTarget } from '../durable-state/controller-state-record-paths.js';
import { gatewayIdentitiesEqual } from '../vm-ownership/vm-ownership-contracts.js';
import {
	appendGatewayLifecycleOperationRecord as appendGatewayLifecycleOperationRecordDefault,
	type GatewayLifecycleGatewayIdentity,
	type GatewayLifecycleOperationRecord,
	type GatewayLifecycleOperationTrigger,
} from './gateway-lifecycle-operation-record.js';
import {
	classifyGatewayStartError,
	deriveGatewayDiagnosisSnapshot,
	type GatewayDiagnosisSnapshot,
	type GatewayLifecycleErrorCode,
	type GatewayLifecycleOperation,
	type GatewayZoneLifecycleState,
} from './gateway-zone-state-machine.js';
import {
	ControllerZoneRuntimeStartError,
	ControllerZoneRuntimeUnavailableError,
} from './zone-runtime-errors.js';
import type {
	ControllerZoneConfig,
	GatewayZoneRuntimeHandle,
	ManagedGatewayZoneRuntime,
	ManagedGatewayZoneRestartOptions,
	ManagedGatewayZoneRestartResult,
} from './zone-runtime-types.js';

type ManagedGatewayZoneConfig = ControllerZoneConfig & {
	readonly gateway: Extract<
		ControllerZoneConfig['gateway'],
		{ readonly type: 'hermes' | 'openclaw' }
	>;
};

export interface CreateManagedGatewayZoneRuntimeOptions {
	readonly clearTimeoutImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
	readonly createFreshSecretResolver?: (() => Promise<SecretResolver>) | undefined;
	readonly createVmOwnership: StartGatewayZoneRequestOptions['createVmOwnership'];
	readonly appendGatewayLifecycleOperationRecord?: (
		record: GatewayLifecycleOperationRecord,
	) => Promise<void>;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly managedVmFactory?: ManagedVmFactory | undefined;
	readonly managedVmExactProcessTermination?:
		| ManagedVmExactProcessTerminationCapability
		| undefined;
	readonly managedVmImages?: ManagedVmImageCapability | undefined;
	readonly managedVmOwnedDirectories?: ManagedVmOwnedDirectoryCapability | undefined;
	readonly now: () => number;
	readonly initialPrebuiltImage?: ManagedVmImageBuildResult | undefined;
	readonly onGatewayRuntimeAttachmentLost?: (transition: GatewayRuntimeAttachmentLost) => void;
	readonly runtimeRecordTarget: ControllerManagedGatewayRuntimeRecordTarget;
	readonly preflightGatewayZoneStart?: typeof preflightGatewayZoneStartDefault;
	readonly recordCurrentControlSessionHealthEvent?: (
		event: Extract<AgentVmHealthEvent, { readonly kind: 'gateway-control-session' }>,
	) => void;
	readonly recordCurrentControlSessionLiveHealthEvent?: (
		event: Extract<AgentVmHealthEvent, { readonly kind: 'gateway-control-session' }>,
	) => void;
	readonly recordNonCurrentControlSessionEvidence?: (
		event: Extract<AgentVmHealthEvent, { readonly kind: 'gateway-control-session' }>,
	) => void;
	readonly restartGatewayZone?: (
		zoneId: string,
		options?: GatewayZoneStartOptions,
	) => Promise<GatewayZoneRuntimeHandle>;
	readonly runControllerCredentialsRefresh?: typeof runControllerCredentialsRefreshDefault;
	readonly runControllerDestroy?: typeof runControllerDestroyDefault;
	readonly runControllerLogs?: typeof runControllerLogsDefault;
	readonly runControllerUpgrade?: typeof runControllerUpgradeDefault;
	readonly secretResolver: SecretResolver;
	readonly setTimeoutImpl?: ((callback: () => void, delayMs: number) => NodeJS.Timeout) | undefined;
	readonly systemConfig: LoadedSystemConfig;
	readonly zone: ManagedGatewayZoneConfig;
}

interface GatewayZoneStartOptions {
	readonly observabilityStartupCheck?: 'default' | 'skip';
	readonly onControlSessionAttemptOutcome?: (outcome: GatewayControlSessionAttemptOutcome) => void;
	readonly onPendingVmCreation?: (containment: PendingGatewayVmCreationContainment) => void;
	readonly onControlSessionHeartbeat?: (transition: GatewayControlSessionHeartbeat) => void;
	readonly onControlSessionHealthEvidence?: (evidence: GatewayControlSessionHealthEvidence) => void;
	readonly onControlSessionReconnectExhausted?: (
		transition: GatewayControlSessionReconnectExhausted,
	) => void;
	readonly onGatewayRuntimeAttachmentLost?: (transition: GatewayRuntimeAttachmentLost) => void;
	readonly prebuiltImage?: ManagedVmImageBuildResult | undefined;
	readonly runtimeEnvironment?: StartGatewayZoneRequestOptions['runtimeEnvironment'];
	readonly runtimePluginConfigs?: StartGatewayZoneRequestOptions['runtimePluginConfigs'];
	readonly secretResolver?: SecretResolver | undefined;
	readonly protectedRestartPreflighted?: boolean | undefined;
}

interface GatewayLifecycleOperationContext {
	readonly operationId: string;
	readonly operationTrigger: GatewayLifecycleOperationTrigger;
	readonly previousGateway?: GatewayZoneRuntimeHandle | undefined;
}

type LifecycleOperationExecution<TResult> =
	| TResult
	| {
			readonly lock: Promise<unknown>;
			readonly publicResult: Promise<TResult>;
	  };

function isLifecycleOperationExecutionWithLock<TResult>(
	execution: LifecycleOperationExecution<TResult>,
): execution is {
	readonly lock: Promise<unknown>;
	readonly publicResult: Promise<TResult>;
} {
	return typeof execution === 'object' && execution !== null && 'lock' in execution;
}

function isOwnerUnsafeLifecycleState(state: GatewayZoneLifecycleState): boolean {
	return (
		state.kind === 'owner-unsafe' ||
		(state.kind === 'failed' && !state.coldStartEligible && state.error.code === 'owner-unsafe')
	);
}

function isRecoverySecretResolutionFailure(
	record: Pick<GatewayLifecycleOperationRecord, 'errorCode' | 'operationTrigger'>,
): boolean {
	return (
		record.errorCode === 'secret-resolution-failed' &&
		(record.operationTrigger === 'auto-recovery' ||
			record.operationTrigger === 'credentials-refresh')
	);
}

class ManagedGatewayZoneRestartTimeoutError extends Error {
	readonly code = 'MANAGED_GATEWAY_RESTART_TIMEOUT';

	constructor(zoneId: string, timeoutMs: number) {
		super(`Managed Gateway restart timed out for zone '${zoneId}' after ${timeoutMs}ms`);
		this.name = 'ManagedGatewayZoneRestartTimeoutError';
	}
}

export function isManagedGatewayZoneRestartTimeoutError(
	error: unknown,
): error is ManagedGatewayZoneRestartTimeoutError {
	return (
		error instanceof Error && 'code' in error && error.code === 'MANAGED_GATEWAY_RESTART_TIMEOUT'
	);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildManagedGatewayCombinedLogsCommand(
	bootContract: GatewayZoneRuntimeHandle['bootContract'],
): string {
	const frameworkLogPath = bootContract.frameworkService.logIdentity.guestPath;
	const toolPortalLogPath = bootContract.toolPortalService.logIdentity.guestPath;
	return [
		`echo ${shellSingleQuote(`===== framework service log (${frameworkLogPath}) =====`)}`,
		`tail -n 400 ${shellSingleQuote(frameworkLogPath)} 2>/dev/null || true`,
		'echo',
		`echo ${shellSingleQuote(`===== Tool Portal service log (${toolPortalLogPath}) =====`)}`,
		`tail -n 400 ${shellSingleQuote(toolPortalLogPath)} 2>/dev/null || true`,
	].join('; ');
}

function writeManagedGatewayZoneRuntimeLog(message: string): void {
	writeControllerDiagnostic('gateway', message);
}

function unavailableReasonForState(state: GatewayZoneLifecycleState): string | undefined {
	switch (state.kind) {
		case 'failed':
			return state.error.message;
		case 'owner-unsafe':
			return `Gateway runtime ownership is unsafe: ${state.evidence.kind}.`;
		case 'restarting':
		case 'starting':
		case 'stopping':
			return `Gateway runtime is ${state.kind}.`;
		case 'running':
		case 'running-degraded':
		case 'stopped':
			return undefined;
	}
	return assertNeverGatewayZoneLifecycleState(state);
}

function assertNeverGatewayZoneLifecycleState(state: never): never {
	throw new Error(`Unhandled gateway zone lifecycle state: ${JSON.stringify(state)}`);
}

function assertNeverGatewayLifecycleOperationRecordKind(kind: never): never {
	throw new Error(`Unhandled gateway lifecycle operation record kind: ${String(kind)}`);
}

function gatewayIdentityFor(
	runtimeGateway: GatewayZoneRuntimeHandle | undefined,
): GatewayLifecycleGatewayIdentity | undefined {
	if (!runtimeGateway) {
		return undefined;
	}
	const hostPid = runtimeGateway.vm.getHostProcessId();
	return {
		...(typeof hostPid === 'number' && hostPid > 0 ? { hostPid } : {}),
		vmId: runtimeGateway.gatewayIdentity.gatewayVmId,
	};
}

function formatGatewayCleanupDebt(
	activeGateway: Pick<GatewayZoneRuntimeHandle, 'gatewayIdentity'>,
	destroyResult: GatewayZoneDestroyResult,
): string | undefined {
	if (destroyResult.kind === 'destroyed-clean') {
		return undefined;
	}
	const cleanupStages = destroyResult.cleanupFailures.map(({ stage }) => stage).join(', ');
	return `Gateway VM '${activeGateway.gatewayIdentity.gatewayVmId}' was destroyed, but cleanup remains incomplete at: ${cleanupStages}.`;
}

function cleanupStageSucceeded(
	destroyResult: GatewayZoneDestroyResult,
	stage: Extract<
		GatewayZoneDestroyResult,
		{ readonly kind: 'destroyed-cleanup-incomplete' }
	>['cleanupFailures'][number]['stage'],
): boolean {
	return (
		destroyResult.kind === 'destroyed-clean' ||
		!destroyResult.cleanupFailures.some((cleanupFailure) => cleanupFailure.stage === stage)
	);
}

export async function requireManagedGatewayStartResult(
	result: GatewayZoneStartResult,
): Promise<ManagedGatewayZoneStartResult> {
	if (result.executionModel === 'managed-gateway') {
		return result;
	}

	let cleanupDebt: string | undefined;
	try {
		cleanupDebt = formatGatewayCleanupDebt(result, await result.destroyGateway());
	} catch (error) {
		throw new Error(
			`Managed Gateway zone runtime rejected direct-process Gateway result for VM '${result.gatewayIdentity.gatewayVmId}' and failed to contain it.`,
			{ cause: error },
		);
	}

	throw new Error(
		`Managed Gateway zone runtime rejected direct-process Gateway result for VM '${result.gatewayIdentity.gatewayVmId}'; managed-gateway lifecycle is required.${cleanupDebt === undefined ? '' : ` ${cleanupDebt}`}`,
	);
}

async function closeGateway(
	activeGateway: GatewayZoneRuntimeHandle,
): Promise<GatewayZoneDestroyResult> {
	return await activeGateway.destroyGateway();
}

async function executeGatewayCommand(
	runtimeGateway: GatewayZoneRuntimeHandle,
	command: string,
): Promise<{
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}> {
	const result = await runtimeGateway.vm.exec(command);
	return {
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

export function createManagedGatewayZoneRuntime(
	options: CreateManagedGatewayZoneRuntimeOptions,
): ManagedGatewayZoneRuntime {
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const requireGatewayManagerDependencies = (): {
		readonly gatewayRuntimeArtifactLimits: typeof controllerFixedGatewayRuntimeArtifactLimits;
		readonly managedVmFactory: ManagedVmFactory;
		readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
		readonly managedVmImages: ManagedVmImageCapability;
		readonly managedVmOwnedDirectories: ManagedVmOwnedDirectoryCapability;
	} => {
		if (
			options.managedVmFactory === undefined ||
			options.managedVmExactProcessTermination === undefined ||
			options.managedVmImages === undefined ||
			options.managedVmOwnedDirectories === undefined
		) {
			throw new Error('Managed Gateway zone runtime requires injected managed VM capabilities.');
		}
		return {
			gatewayRuntimeArtifactLimits: controllerFixedGatewayRuntimeArtifactLimits,
			managedVmFactory: options.managedVmFactory,
			managedVmExactProcessTermination: options.managedVmExactProcessTermination,
			managedVmImages: options.managedVmImages,
			managedVmOwnedDirectories: options.managedVmOwnedDirectories,
		};
	};
	const appendGatewayLifecycleOperationRecord = options.appendGatewayLifecycleOperationRecord;
	let gateway: GatewayZoneRuntimeHandle | undefined;
	let bootedAt: string | undefined;
	let lastError: string | undefined;
	let lastOperation: GatewayLifecycleOperation = 'none';
	let originalOutageCause: GatewayDiagnosisSnapshot['originalOutageCause'] = { kind: 'unknown' };
	let lifecycleState: GatewayZoneLifecycleState = { kind: 'stopped' };
	let lifecycleOperation: Promise<void> = Promise.resolve();
	let lifecycleGeneration = 0;
	let staleGatewayPendingClose: GatewayZoneRuntimeHandle | undefined;
	const recordControlSessionHealthEvidence = (
		evidence: GatewayControlSessionHealthEvidence,
	): void => {
		if (evidence.event.windowState === 'closed' && evidence.event.terminalReason !== 'accepted') {
			options.recordNonCurrentControlSessionEvidence?.(evidence.event);
			return;
		}
		const currentGateway = gateway;
		const sourceIsCurrent =
			currentGateway !== undefined &&
			(lifecycleState.kind === 'running' || lifecycleState.kind === 'running-degraded') &&
			gatewayIdentitiesEqual(currentGateway.gatewayIdentity, evidence.gateway);
		if (sourceIsCurrent) {
			if (evidence.recordKind === 'live-only') {
				options.recordCurrentControlSessionLiveHealthEvent?.(evidence.event);
			} else {
				options.recordCurrentControlSessionHealthEvent?.(evidence.event);
			}
			return;
		}
		if (evidence.event.windowState === 'closed') {
			options.recordNonCurrentControlSessionEvidence?.(evidence.event);
		}
	};

	const startGateway = async (
		startOptions: GatewayZoneStartOptions = {},
	): Promise<GatewayZoneRuntimeHandle> => {
		if (options.restartGatewayZone) {
			return await options.restartGatewayZone(options.zone.id, {
				...startOptions,
				onControlSessionHealthEvidence: recordControlSessionHealthEvidence,
				...(options.onGatewayRuntimeAttachmentLost === undefined
					? {}
					: { onGatewayRuntimeAttachmentLost: options.onGatewayRuntimeAttachmentLost }),
			});
		}

		return await requireManagedGatewayStartResult(
			await startGatewayZone(
				{
					...(startOptions.observabilityStartupCheck
						? { observabilityStartupCheck: startOptions.observabilityStartupCheck }
						: {}),
					...(startOptions.prebuiltImage ? { prebuiltImage: startOptions.prebuiltImage } : {}),
					...(startOptions.onPendingVmCreation
						? { onPendingVmCreation: startOptions.onPendingVmCreation }
						: {}),
					...(startOptions.onControlSessionReconnectExhausted
						? {
								onControlSessionReconnectExhausted: startOptions.onControlSessionReconnectExhausted,
							}
						: {}),
					...(startOptions.onControlSessionHeartbeat
						? { onControlSessionHeartbeat: startOptions.onControlSessionHeartbeat }
						: {}),
					onControlSessionHealthEvidence: recordControlSessionHealthEvidence,
					...(options.onGatewayRuntimeAttachmentLost === undefined
						? {}
						: { onGatewayRuntimeAttachmentLost: options.onGatewayRuntimeAttachmentLost }),
					...(startOptions.onControlSessionAttemptOutcome
						? {
								onControlSessionAttemptOutcome: startOptions.onControlSessionAttemptOutcome,
							}
						: {}),
					...(startOptions.runtimeEnvironment
						? { runtimeEnvironment: startOptions.runtimeEnvironment }
						: {}),
					...(startOptions.runtimePluginConfigs
						? { runtimePluginConfigs: startOptions.runtimePluginConfigs }
						: {}),
					createVmOwnership: options.createVmOwnership,
					runtimeRecordTarget: options.runtimeRecordTarget,
					secretResolver: startOptions.secretResolver ?? options.secretResolver,
					systemConfig: options.systemConfig,
					zoneId: options.zone.id,
				},
				requireGatewayManagerDependencies(),
			),
		);
	};

	const requireGateway = (): GatewayZoneRuntimeHandle => {
		const currentState = getLifecycleState();
		if (currentState.kind !== 'running' && currentState.kind !== 'running-degraded') {
			throw new ControllerZoneRuntimeUnavailableError(
				options.zone.id,
				lastError ?? unavailableReasonForState(currentState),
			);
		}
		return currentState.gateway;
	};

	const runGatewayHealthProbe = async (
		activeGateway: GatewayZoneRuntimeHandle,
		healthCheck: GatewayHealthCheck,
	): Promise<{
		readonly ok: boolean;
		readonly observation: string;
		readonly path?: string | undefined;
		readonly port?: number | undefined;
		readonly statusCode?: number | undefined;
		readonly zoneId: string;
	}> => {
		const result = await runGatewayHealthCheck({
			exec: async (command) => await executeGatewayCommand(activeGateway, command),
			healthCheck,
		});
		return {
			ok: result.ok,
			observation: result.observation,
			...(result.path === undefined ? {} : { path: result.path }),
			...(result.port === undefined ? {} : { port: result.port }),
			...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
			zoneId: options.zone.id,
		};
	};

	const createOperationId = (operationName: string): string =>
		`${options.zone.id}-${operationName}-${randomUUID()}`;

	const operationForRecordKind = (
		kind: GatewayLifecycleOperationRecord['kind'],
	): GatewayLifecycleOperation | undefined => {
		switch (kind) {
			case 'cold-start-requested':
				return 'cold-start';
			case 'credentials-refresh-requested':
				return 'credentials-refresh';
			case 'restart-requested':
				return 'restart';
			case 'start-requested':
				return 'start';
			case 'stop-requested':
				return 'stop';
			case 'operation-failed':
			case 'operation-finished':
			case 'runtime-record-deleted':
			case 'runtime-record-written':
			case 'vm-close-finished':
			case 'vm-close-started':
				return undefined;
		}
		return assertNeverGatewayLifecycleOperationRecordKind(kind);
	};

	const setOriginalOutageCauseIfUnknown = (
		errorCode: GatewayLifecycleErrorCode | undefined,
	): void => {
		if (originalOutageCause.kind !== 'unknown') {
			return;
		}
		originalOutageCause = {
			...(errorCode === undefined ? {} : { errorCode }),
			eventKind: 'gateway-lifecycle-operation',
			kind: 'proven',
		};
	};

	const recordLifecycleOperation = async (
		record: Omit<
			GatewayLifecycleOperationRecord,
			'controllerPid' | 'gatewayType' | 'observedAtMs' | 'zoneId'
		>,
	): Promise<void> => {
		const operation = operationForRecordKind(record.kind);
		if (operation !== undefined) {
			lastOperation = operation;
		}
		if (
			record.kind === 'operation-failed' &&
			!isRecoverySecretResolutionFailure(record) &&
			lifecycleState.kind !== 'running' &&
			lifecycleState.kind !== 'running-degraded'
		) {
			setOriginalOutageCauseIfUnknown(record.errorCode);
		}
		const operationRecord = {
			controllerPid: process.pid,
			gatewayType: options.zone.gateway.type,
			observedAtMs: options.now(),
			zoneId: options.zone.id,
			...record,
		} satisfies GatewayLifecycleOperationRecord;
		try {
			if (appendGatewayLifecycleOperationRecord) {
				await appendGatewayLifecycleOperationRecord(operationRecord);
				return;
			}
			await appendGatewayLifecycleOperationRecordDefault({
				record: operationRecord,
				zoneRuntimeDir: options.zone.gateway.zoneRuntimeDir,
			});
		} catch (error) {
			writeManagedGatewayZoneRuntimeLog(
				`failed to append gateway lifecycle operation record for zone '${options.zone.id}': ${formatUnknownError(error)}`,
			);
		}
	};

	const markGatewayHostPidMissing = (
		message: string,
	): Extract<GatewayZoneLifecycleState, { readonly kind: 'failed' }> => {
		if (
			staleGatewayPendingClose === undefined &&
			(lifecycleState.kind === 'running' || lifecycleState.kind === 'running-degraded')
		) {
			staleGatewayPendingClose = lifecycleState.gateway;
		}
		const errorMessage = `vm-process-missing: ${message}`;
		setOriginalOutageCauseIfUnknown('vm-process-missing');
		gateway = undefined;
		bootedAt = undefined;
		lastError = errorMessage;
		lifecycleState = {
			coldStartEligible: true,
			error: { code: 'vm-process-missing', message: errorMessage },
			kind: 'failed',
		};
		return lifecycleState;
	};

	const closeStaleGatewayBeforeColdStart = async (
		operationContext: GatewayLifecycleOperationContext,
	): Promise<void> => {
		const staleGateway = staleGatewayPendingClose;
		if (!staleGateway) {
			return;
		}
		staleGatewayPendingClose = undefined;
		try {
			await recordLifecycleOperation({
				kind: 'vm-close-started',
				operationId: operationContext.operationId,
				operationTrigger: operationContext.operationTrigger,
				previousGateway: gatewayIdentityFor(staleGateway),
			});
			const destroyResult = await closeGateway(staleGateway);
			await recordLifecycleOperation({
				kind: 'vm-close-finished',
				operationId: operationContext.operationId,
				operationTrigger: operationContext.operationTrigger,
				previousGateway: gatewayIdentityFor(staleGateway),
			});
			const cleanupDebt = formatGatewayCleanupDebt(staleGateway, destroyResult);
			if (cleanupDebt !== undefined) {
				await recordLifecycleOperation({
					errorMessage: cleanupDebt,
					kind: 'operation-failed',
					operationId: operationContext.operationId,
					operationTrigger: operationContext.operationTrigger,
					previousGateway: gatewayIdentityFor(staleGateway),
				});
				writeManagedGatewayZoneRuntimeLog(cleanupDebt);
			}
		} catch (error) {
			staleGatewayPendingClose = staleGateway;
			lastError = formatUnknownError(error);
			lifecycleState = {
				coldStartEligible: false,
				error: {
					code: 'owner-unsafe',
					message: lastError,
				},
				kind: 'failed',
			};
			await recordLifecycleOperation({
				errorCode: 'owner-unsafe',
				errorMessage: lastError,
				kind: 'operation-failed',
				operationId: operationContext.operationId,
				operationTrigger: operationContext.operationTrigger,
				previousGateway: gatewayIdentityFor(staleGateway),
			});
			throw error;
		}
	};

	const classifyLastError = (message: string): GatewayZoneLifecycleState => {
		if (message.startsWith('vm-process-missing:')) {
			return {
				coldStartEligible: true,
				error: { code: 'vm-process-missing', message },
				kind: 'failed',
			};
		}
		const error = classifyGatewayStartError(new Error(message));
		return {
			coldStartEligible: error.code !== 'owner-unsafe',
			error,
			kind: 'failed',
		};
	};

	const getLifecycleState = (): GatewayZoneLifecycleState => {
		if (lifecycleState.kind === 'running' || lifecycleState.kind === 'running-degraded') {
			const hostPid = lifecycleState.gateway.vm.getHostProcessId();
			if (hostPid === undefined || hostPid === null) {
				return markGatewayHostPidMissing(
					`Gateway VM host pid is unavailable for zone '${options.zone.id}'.`,
				);
			}
			if (!isProcessAlive(hostPid)) {
				return markGatewayHostPidMissing(
					`Gateway VM host pid ${String(hostPid)} is not alive for zone '${options.zone.id}'.`,
				);
			}
			return lifecycleState;
		}
		if (lifecycleState.kind === 'failed' || lifecycleState.kind === 'owner-unsafe') {
			return lifecycleState;
		}
		if (
			lifecycleState.kind === 'starting' ||
			lifecycleState.kind === 'stopping' ||
			lifecycleState.kind === 'restarting'
		) {
			return lifecycleState;
		}
		if (lastError) {
			lifecycleState = classifyLastError(lastError);
			return lifecycleState;
		}
		return lifecycleState;
	};

	const assertGatewaySuccessorCreationAllowed = (): void => {
		const currentState = getLifecycleState();
		if (currentState.kind === 'failed' && !currentState.coldStartEligible) {
			throw new ControllerZoneRuntimeUnavailableError(options.zone.id, currentState.error.message);
		}
	};

	const runLifecycleOperation = async <TResult>(
		operation: () =>
			| LifecycleOperationExecution<TResult>
			| Promise<LifecycleOperationExecution<TResult>>,
	): Promise<TResult> => {
		const runAfterPrevious = async (): Promise<LifecycleOperationExecution<TResult>> => {
			await lifecycleOperation.catch(() => undefined);
			return await operation();
		};
		const executionPromise = runAfterPrevious();
		const operationResultPromise = executionPromise.then(async (execution) => {
			if (isLifecycleOperationExecutionWithLock(execution)) {
				return await execution.publicResult;
			}
			return await execution;
		});
		lifecycleOperation = executionPromise
			.then(async (execution) => {
				if (isLifecycleOperationExecutionWithLock(execution)) {
					await execution.lock;
					return;
				}
				await execution;
			})
			.then(
				() => undefined,
				() => undefined,
			);
		return await operationResultPromise;
	};

	const withLifecycleTimeout = <TResult>(props: {
		readonly invalidateLifecycleGeneration?: boolean;
		readonly releaseLockWhen?: Promise<void> | undefined;
		readonly onTimeout?: () => void;
		readonly operation: Promise<TResult>;
		readonly timeoutError?: () => Error;
		readonly timeoutMs: number;
	}): { readonly lock: Promise<unknown>; readonly publicResult: Promise<TResult> } => {
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeoutImpl(() => {
				if (props.invalidateLifecycleGeneration !== false) {
					lifecycleGeneration += 1;
				}
				props.onTimeout?.();
				reject(
					props.timeoutError?.() ??
						new ManagedGatewayZoneRestartTimeoutError(options.zone.id, props.timeoutMs),
				);
			}, props.timeoutMs);
			timeout.unref?.();
		});
		const publicResult = Promise.race([props.operation, timeoutPromise]).finally(() => {
			if (timeout) {
				clearTimeoutImpl(timeout);
			}
		});
		const operationSettled = props.operation.then(
			() => undefined,
			() => undefined,
		);
		return {
			lock:
				props.releaseLockWhen === undefined
					? operationSettled
					: Promise.race([operationSettled, props.releaseLockWhen]),
			publicResult,
		};
	};

	const createPendingVmCreationTimeoutContainment = (
		operationContext: GatewayLifecycleOperationContext,
	): {
		readonly releaseLifecycleLock: Promise<void>;
		onPendingVmCreation(containment: PendingGatewayVmCreationContainment): void;
		onTimeout(): void;
	} => {
		let containmentStarted = false;
		let pendingVmCreation: PendingGatewayVmCreationContainment | undefined;
		let releaseLifecycleLock: (() => void) | undefined;
		let timeoutExpired = false;
		const containmentTerminal = new Promise<void>((resolve) => {
			releaseLifecycleLock = resolve;
		});

		const containPendingVmCreation = (): void => {
			if (containmentStarted || pendingVmCreation === undefined) {
				return;
			}
			containmentStarted = true;
			void pendingVmCreation
				.contain()
				.catch((error: unknown) => {
					const errorMessage = `Pending Gateway VM creation containment is owner-unsafe for zone '${options.zone.id}': ${formatUnknownError(error)}`;
					lastError = errorMessage;
					lifecycleState = {
						coldStartEligible: false,
						error: { code: 'owner-unsafe', message: errorMessage },
						kind: 'failed',
					};
					void recordLifecycleOperation({
						errorCode: 'owner-unsafe',
						errorMessage,
						kind: 'operation-failed',
						operationId: operationContext.operationId,
						operationTrigger: operationContext.operationTrigger,
						previousGateway: gatewayIdentityFor(operationContext.previousGateway),
					}).catch((recordError: unknown) => {
						writeManagedGatewayZoneRuntimeLog(
							`failed to record pending Gateway VM containment failure for zone '${options.zone.id}': ${formatUnknownError(recordError)}`,
						);
					});
				})
				.finally(() => {
					releaseLifecycleLock?.();
					releaseLifecycleLock = undefined;
				});
		};

		return {
			onPendingVmCreation(containment): void {
				pendingVmCreation = containment;
				if (timeoutExpired) {
					containPendingVmCreation();
				}
			},
			onTimeout(): void {
				timeoutExpired = true;
				containPendingVmCreation();
			},
			releaseLifecycleLock: containmentTerminal,
		};
	};

	const abortIfLifecycleGenerationStale = async (props: {
		readonly operationContext: GatewayLifecycleOperationContext;
		readonly operationGeneration: number;
		readonly previousGateway?: GatewayZoneRuntimeHandle | undefined;
		readonly stage: string;
		readonly timeoutMs?: number | undefined;
	}): Promise<void> => {
		if (props.operationGeneration === lifecycleGeneration) {
			return;
		}
		const errorMessage = `stale-generation-closed: Aborted stale gateway lifecycle operation for zone '${options.zone.id}' before ${props.stage}.`;
		lastError = errorMessage;
		if (props.previousGateway !== undefined) {
			gateway = props.previousGateway;
			lifecycleState = { gateway: props.previousGateway, kind: 'running' };
		} else {
			lifecycleState = classifyLastError(errorMessage);
		}
		await recordLifecycleOperation({
			errorCode: 'stale-generation-closed',
			errorMessage,
			kind: 'operation-failed',
			operationId: props.operationContext.operationId,
			operationTrigger: props.operationContext.operationTrigger,
			previousGateway: gatewayIdentityFor(props.previousGateway),
		});
		throw new ManagedGatewayZoneRestartTimeoutError(options.zone.id, props.timeoutMs ?? 0);
	};

	const stopNow = async (
		next: 'stopped' | 'starting' = 'stopped',
		operationContext?: GatewayLifecycleOperationContext,
		closeForControllerShutdown = false,
	): Promise<void> => {
		const activeGateway = gateway;
		if (activeGateway === undefined && isOwnerUnsafeLifecycleState(getLifecycleState())) {
			return;
		}
		const operationId = operationContext?.operationId ?? createOperationId('stop');
		const operationTrigger = operationContext?.operationTrigger ?? 'operator-stop';
		const previousGateway = operationContext?.previousGateway ?? activeGateway;
		lifecycleState = {
			kind: 'stopping',
			next,
			operationId,
			previousGateway,
		};
		if (closeForControllerShutdown) {
			try {
				activeGateway?.controlSession?.closeForControllerShutdown();
			} catch (error) {
				writeManagedGatewayZoneRuntimeLog(
					`Failed to close the control session for controller shutdown in zone '${options.zone.id}': ${formatUnknownError(error)}`,
				);
			}
		}
		try {
			await recordLifecycleOperation({
				kind: 'stop-requested',
				operationId,
				operationTrigger,
				previousGateway: gatewayIdentityFor(previousGateway),
			});
			if (activeGateway) {
				await recordLifecycleOperation({
					kind: 'vm-close-started',
					operationId,
					operationTrigger,
					previousGateway: gatewayIdentityFor(previousGateway),
				});
				const destroyResult = await closeGateway(activeGateway);
				await recordLifecycleOperation({
					kind: 'vm-close-finished',
					operationId,
					operationTrigger,
					previousGateway: gatewayIdentityFor(previousGateway),
				});
				if (cleanupStageSucceeded(destroyResult, 'runtime-record-deletion')) {
					await recordLifecycleOperation({
						kind: 'runtime-record-deleted',
						operationId,
						operationTrigger,
						previousGateway: gatewayIdentityFor(previousGateway),
					});
				}
				const cleanupDebt = formatGatewayCleanupDebt(activeGateway, destroyResult);
				if (cleanupDebt !== undefined) {
					await recordLifecycleOperation({
						errorMessage: cleanupDebt,
						kind: 'operation-failed',
						operationId,
						operationTrigger,
						previousGateway: gatewayIdentityFor(previousGateway),
					});
					writeManagedGatewayZoneRuntimeLog(cleanupDebt);
				}
			}
			gateway = undefined;
			bootedAt = undefined;
			lastError = undefined;
			lifecycleState = { kind: 'stopped' };
		} catch (error) {
			lastError = formatUnknownError(error);
			lifecycleState = {
				coldStartEligible: false,
				error: {
					code: 'owner-unsafe',
					message: lastError,
				},
				kind: 'failed',
			};
			await recordLifecycleOperation({
				errorCode: 'owner-unsafe',
				errorMessage: lastError,
				kind: 'operation-failed',
				operationId,
				operationTrigger,
				previousGateway: gatewayIdentityFor(previousGateway),
			});
			throw error;
		}
	};

	const startNow = async (
		expectedGeneration?: number,
		startOptions: GatewayZoneStartOptions = {},
		operationContext?: GatewayLifecycleOperationContext,
	): Promise<void> => {
		const operationId = operationContext?.operationId ?? createOperationId('start');
		const operationTrigger = operationContext?.operationTrigger ?? 'operator-start';
		lifecycleState = {
			kind: 'starting',
			operationId,
			startedAtMs: options.now(),
		};
		try {
			await recordLifecycleOperation({
				kind: 'start-requested',
				operationId,
				operationTrigger,
				previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
			});
			const startedGateway = await startGateway({
				...startOptions,
				onControlSessionAttemptOutcome: (outcome) => {
					const attemptResult =
						outcome.kind === 'hello_response'
							? `hello_response:${outcome.outcome}`
							: 'connect_error';
					writeManagedGatewayZoneRuntimeLog(
						`control attachment attempt for zone '${options.zone.id}' process '${outcome.processEpoch}' attachment ${String(outcome.attachmentGeneration)}: ${attemptResult}`,
					);
				},
			});
			if (expectedGeneration !== undefined && expectedGeneration !== lifecycleGeneration) {
				try {
					const destroyResult = await closeGateway(startedGateway);
					if (
						lifecycleGeneration === expectedGeneration + 1 &&
						cleanupStageSucceeded(destroyResult, 'runtime-record-deletion')
					) {
						await recordLifecycleOperation({
							currentGateway: gatewayIdentityFor(startedGateway),
							kind: 'runtime-record-deleted',
							operationId,
							operationTrigger,
							previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
						});
					}
					const cleanupDebt = formatGatewayCleanupDebt(startedGateway, destroyResult);
					if (cleanupDebt !== undefined) {
						await recordLifecycleOperation({
							currentGateway: gatewayIdentityFor(startedGateway),
							errorCode: 'stale-generation-closed',
							errorMessage: cleanupDebt,
							kind: 'operation-failed',
							operationId,
							operationTrigger,
							previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
						});
						writeManagedGatewayZoneRuntimeLog(cleanupDebt);
					}
					lastError = `stale-generation-closed: Closed stale gateway start for zone '${options.zone.id}'.`;
					lifecycleState = classifyLastError(lastError);
					await recordLifecycleOperation({
						currentGateway: gatewayIdentityFor(startedGateway),
						errorCode: 'stale-generation-closed',
						errorMessage: lastError,
						kind: 'operation-failed',
						operationId,
						operationTrigger,
						previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
					});
				} catch (error) {
					lastError = `stale-generation-closed: Failed to close stale gateway start for zone '${options.zone.id}': ${formatUnknownError(error)}`;
					lifecycleState = classifyLastError(lastError);
					await recordLifecycleOperation({
						currentGateway: gatewayIdentityFor(startedGateway),
						errorCode: 'stale-generation-closed',
						errorMessage: lastError,
						kind: 'operation-failed',
						operationId,
						operationTrigger,
						previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
					});
					writeManagedGatewayZoneRuntimeLog(
						`stale gateway start cleanup failed for zone '${options.zone.id}': ${formatUnknownError(error)}`,
					);
				}
				return;
			}
			gateway = startedGateway;
			bootedAt = new Date(options.now()).toISOString();
			lastError = undefined;
			lifecycleState = { gateway: startedGateway, kind: 'running' };
			await recordLifecycleOperation({
				currentGateway: gatewayIdentityFor(startedGateway),
				kind: 'operation-finished',
				operationId,
				operationTrigger,
				previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
			});
		} catch (error) {
			if (gateway === undefined && isOwnerUnsafeLifecycleState(getLifecycleState())) {
				throw error;
			}
			if (error instanceof GatewayOwnershipUnsafeError) {
				gateway = undefined;
				bootedAt = undefined;
				lastError = error.message;
				lifecycleState = {
					evidence: error.evidence,
					kind: 'owner-unsafe',
				};
				await recordLifecycleOperation({
					errorCode: 'owner-unsafe',
					errorMessage: error.message,
					kind: 'operation-failed',
					operationId,
					operationTrigger,
					previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
				});
				throw new ControllerZoneRuntimeStartError(options.zone.id, error, {
					gatewayLifecycleErrorCode: 'owner-unsafe',
					operationId,
				});
			}
			const classifiedError = classifyGatewayStartError(error);
			gateway = undefined;
			bootedAt = undefined;
			lastError = formatUnknownError(error);
			lifecycleState = {
				coldStartEligible: true,
				error: classifiedError,
				kind: 'failed',
			};
			await recordLifecycleOperation({
				errorCode: classifiedError.code,
				errorMessage: classifiedError.message,
				kind: 'operation-failed',
				operationId,
				operationTrigger,
				previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
			});
			throw new ControllerZoneRuntimeStartError(options.zone.id, error, {
				gatewayLifecycleErrorCode: classifiedError.code,
				operationId,
			});
		}
	};

	const preflightGatewayStartOptions = async (
		startOptions: GatewayZoneStartOptions,
		operationContext: GatewayLifecycleOperationContext,
	): Promise<GatewayZoneStartOptions> => {
		if (startOptions.protectedRestartPreflighted === true) {
			return startOptions;
		}
		try {
			const preflightOptions = {
				...(startOptions.runtimeEnvironment
					? { runtimeEnvironment: startOptions.runtimeEnvironment }
					: {}),
				...(startOptions.runtimePluginConfigs
					? { runtimePluginConfigs: startOptions.runtimePluginConfigs }
					: {}),
				secretResolver: startOptions.secretResolver ?? options.secretResolver,
				systemConfig: options.systemConfig,
				zoneId: options.zone.id,
			};
			const preflightResult =
				options.preflightGatewayZoneStart === undefined
					? await preflightGatewayZoneStartDefault(
							preflightOptions,
							requireGatewayManagerDependencies(),
						)
					: await options.preflightGatewayZoneStart(
							preflightOptions,
							requireGatewayManagerDependencies(),
						);
			return {
				...startOptions,
				...(preflightResult.image ? { prebuiltImage: preflightResult.image } : {}),
				observabilityStartupCheck: 'skip',
				protectedRestartPreflighted: true,
				secretResolver: preflightResult.secretResolver,
			};
		} catch (error) {
			const classifiedError = classifyGatewayStartError(error);
			lastError = formatUnknownError(error);
			await recordLifecycleOperation({
				errorCode: classifiedError.code,
				errorMessage: classifiedError.message,
				kind: 'operation-failed',
				operationId: operationContext.operationId,
				operationTrigger: operationContext.operationTrigger,
				previousGateway: gatewayIdentityFor(operationContext.previousGateway),
			});
			throw new ControllerZoneRuntimeStartError(options.zone.id, error, {
				gatewayLifecycleErrorCode: classifiedError.code,
				operationId: operationContext.operationId,
			});
		}
	};

	const stop = async (): Promise<void> => {
		await runLifecycleOperation(async () => await stopNow());
	};

	const shutdown = async (): Promise<void> => {
		await runLifecycleOperation(async () => await stopNow('stopped', undefined, true));
	};

	const start = async (): Promise<void> =>
		await runLifecycleOperation(async () => {
			assertGatewaySuccessorCreationAllowed();
			return await startNow(
				undefined,
				options.initialPrebuiltImage === undefined
					? {}
					: { prebuiltImage: options.initialPrebuiltImage },
				{
					operationId: createOperationId('start'),
					operationTrigger: 'controller-start',
				},
			);
		});

	const restartWithStartOptions = async (
		restartOptions: ManagedGatewayZoneRestartOptions = {},
		startOptions: GatewayZoneStartOptions = {},
		operationMetadata: {
			readonly operationId?: string | undefined;
			readonly operationTrigger?: GatewayLifecycleOperationTrigger | undefined;
		} = {},
	): Promise<ManagedGatewayZoneRestartResult> => {
		return await runLifecycleOperation<ManagedGatewayZoneRestartResult>(async () => {
			lifecycleGeneration += 1;
			const operationGeneration = lifecycleGeneration;
			const currentState = getLifecycleState();
			const operationId = operationMetadata.operationId ?? createOperationId('restart');
			const operationContext: GatewayLifecycleOperationContext = {
				operationId,
				operationTrigger:
					operationMetadata.operationTrigger ??
					restartOptions.operationTrigger ??
					'operator-restart',
				previousGateway:
					currentState.kind === 'running' || currentState.kind === 'running-degraded'
						? currentState.gateway
						: undefined,
			};
			const pendingVmCreationContainment =
				createPendingVmCreationTimeoutContainment(operationContext);
			const startOptionsWithPendingContainment: GatewayZoneStartOptions =
				restartOptions.timeoutMs === undefined
					? startOptions
					: {
							...startOptions,
							onPendingVmCreation: (containment) => {
								pendingVmCreationContainment.onPendingVmCreation(containment);
							},
						};
			const restartOperation =
				currentState.kind === 'running' || currentState.kind === 'running-degraded'
					? (async (): Promise<ManagedGatewayZoneRestartResult> => {
							await recordLifecycleOperation({
								kind: 'restart-requested',
								operationId,
								operationTrigger: operationContext.operationTrigger,
								previousGateway: gatewayIdentityFor(operationContext.previousGateway),
							});
							const preflightedStartOptions = await preflightGatewayStartOptions(
								startOptionsWithPendingContainment,
								operationContext,
							);
							await abortIfLifecycleGenerationStale({
								operationContext,
								operationGeneration,
								previousGateway: currentState.gateway,
								stage: 'lease release',
								timeoutMs: restartOptions.timeoutMs,
							});
							lifecycleState = {
								kind: 'restarting',
								operationId,
								previousGateway: currentState.gateway,
							};
							await abortIfLifecycleGenerationStale({
								operationContext,
								operationGeneration,
								previousGateway: currentState.gateway,
								stage: 'gateway VM close',
								timeoutMs: restartOptions.timeoutMs,
							});
							await stopNow('starting', operationContext);
							await startNow(operationGeneration, preflightedStartOptions, operationContext);
							if (operationGeneration !== lifecycleGeneration) {
								throw new ManagedGatewayZoneRestartTimeoutError(
									options.zone.id,
									restartOptions.timeoutMs ?? 0,
								);
							}
							return {
								leaseReleaseFailureCount: 0,
								operationId,
							};
						})()
					: (async (): Promise<ManagedGatewayZoneRestartResult> => {
							assertGatewaySuccessorCreationAllowed();
							await recordLifecycleOperation({
								kind: 'cold-start-requested',
								operationId,
								operationTrigger: operationContext.operationTrigger,
							});
							const preflightedStartOptions = await preflightGatewayStartOptions(
								startOptionsWithPendingContainment,
								operationContext,
							);
							await abortIfLifecycleGenerationStale({
								operationContext,
								operationGeneration,
								stage: 'lease release',
								timeoutMs: restartOptions.timeoutMs,
							});
							await abortIfLifecycleGenerationStale({
								operationContext,
								operationGeneration,
								stage: 'stale gateway close',
								timeoutMs: restartOptions.timeoutMs,
							});
							await closeStaleGatewayBeforeColdStart(operationContext);
							await startNow(operationGeneration, preflightedStartOptions, operationContext);
							if (operationGeneration !== lifecycleGeneration) {
								throw new ManagedGatewayZoneRestartTimeoutError(
									options.zone.id,
									restartOptions.timeoutMs ?? 0,
								);
							}
							return {
								leaseReleaseFailureCount: 0,
								operationId,
							};
						})();

			if (restartOptions.timeoutMs === undefined) {
				return await restartOperation;
			}

			return withLifecycleTimeout({
				onTimeout: () => {
					pendingVmCreationContainment.onTimeout();
				},
				operation: restartOperation,
				releaseLockWhen: pendingVmCreationContainment.releaseLifecycleLock,
				timeoutMs: restartOptions.timeoutMs,
			});
		});
	};

	const restart = async (
		restartOptions: ManagedGatewayZoneRestartOptions = {},
	): Promise<ManagedGatewayZoneRestartResult> => await restartWithStartOptions(restartOptions);

	const coldStartWithStartOptions = async (
		restartOptions: ManagedGatewayZoneRestartOptions = {},
		startOptions: GatewayZoneStartOptions = {},
		operationMetadata: {
			readonly operationId?: string | undefined;
			readonly operationTrigger?: GatewayLifecycleOperationTrigger | undefined;
		} = {},
	): Promise<ManagedGatewayZoneRestartResult> => {
		return await runLifecycleOperation<ManagedGatewayZoneRestartResult>(async () => {
			lifecycleGeneration += 1;
			const operationGeneration = lifecycleGeneration;
			const operationContext: GatewayLifecycleOperationContext = {
				operationId: operationMetadata.operationId ?? createOperationId('cold-start'),
				operationTrigger:
					operationMetadata.operationTrigger ?? restartOptions.operationTrigger ?? 'auto-recovery',
			};
			const pendingVmCreationContainment =
				createPendingVmCreationTimeoutContainment(operationContext);
			const startOptionsWithPendingContainment: GatewayZoneStartOptions =
				restartOptions.timeoutMs === undefined
					? startOptions
					: {
							...startOptions,
							onPendingVmCreation: (containment) => {
								pendingVmCreationContainment.onPendingVmCreation(containment);
							},
						};
			const coldStartOperation = (async (): Promise<ManagedGatewayZoneRestartResult> => {
				assertGatewaySuccessorCreationAllowed();
				await recordLifecycleOperation({
					kind: 'cold-start-requested',
					operationId: operationContext.operationId,
					operationTrigger: operationContext.operationTrigger,
				});
				const preflightedStartOptions = await preflightGatewayStartOptions(
					startOptionsWithPendingContainment,
					operationContext,
				);
				await abortIfLifecycleGenerationStale({
					operationContext,
					operationGeneration,
					stage: 'lease release',
					timeoutMs: restartOptions.timeoutMs,
				});
				await abortIfLifecycleGenerationStale({
					operationContext,
					operationGeneration,
					stage: 'stale gateway close',
					timeoutMs: restartOptions.timeoutMs,
				});
				await closeStaleGatewayBeforeColdStart(operationContext);
				await startNow(operationGeneration, preflightedStartOptions, operationContext);
				if (operationGeneration !== lifecycleGeneration) {
					throw new ManagedGatewayZoneRestartTimeoutError(
						options.zone.id,
						restartOptions.timeoutMs ?? 0,
					);
				}
				return {
					leaseReleaseFailureCount: 0,
					operationId: operationContext.operationId,
				};
			})();

			if (restartOptions.timeoutMs === undefined) {
				return await coldStartOperation;
			}

			return withLifecycleTimeout({
				onTimeout: () => {
					pendingVmCreationContainment.onTimeout();
				},
				operation: coldStartOperation,
				releaseLockWhen: pendingVmCreationContainment.releaseLifecycleLock,
				timeoutMs: restartOptions.timeoutMs,
			});
		});
	};

	const coldStart = async (
		restartOptions: ManagedGatewayZoneRestartOptions = {},
	): Promise<ManagedGatewayZoneRestartResult> => await coldStartWithStartOptions(restartOptions);

	return {
		coldStart,
		destroy: async (purge) =>
			await (options.runControllerDestroy ?? runControllerDestroyDefault)(
				{ purge, systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					releaseZoneLeases: async () => {},
					stopGatewayZone: async () => await stop(),
				},
			),
		enableSsh: async () => await requireGateway().vm.enableSsh(),
		ensureCurrentControlSessionDialing: (sourceKey) => {
			const currentState = getLifecycleState();
			if (currentState.kind !== 'running' && currentState.kind !== 'running-degraded') {
				return { status: 'not-current' };
			}
			const identity = currentState.gateway.gatewayIdentity;
			if (
				sourceKey.domain !== 'gateway_control' ||
				sourceKey.zoneId !== identity.zoneId ||
				sourceKey.gatewayVmId !== identity.gatewayVmId ||
				sourceKey.bootId !== identity.bootId ||
				sourceKey.generationId !== identity.generationId
			) {
				return { status: 'not-current' };
			}
			return (
				currentState.gateway.controlSession?.ensureDialing('stale-health') ?? {
					status: 'control-session-unavailable',
				}
			);
		},
		exec: async (command) => await executeGatewayCommand(requireGateway(), command),
		gatewayType: options.zone.gateway.type,
		getHealth: async () => {
			getLifecycleState();
			const activeGateway = requireGateway();
			const readiness = activeGateway.bootContract.frameworkService.readiness;
			return await runGatewayHealthProbe(activeGateway, {
				path: readiness.path,
				port: readiness.guestPort,
				type: 'http',
			});
		},
		getServiceHealth: async () => {
			getLifecycleState();
			const activeGateway = requireGateway();
			const readiness = activeGateway.bootContract.frameworkService.readiness;
			return await runGatewayHealthProbe(activeGateway, {
				path: readiness.path,
				port: readiness.guestPort,
				type: 'http',
			});
		},
		getDiagnosis: () =>
			deriveGatewayDiagnosisSnapshot({
				channelProviderPlane: 'unknown',
				controllerLiveness: 'ok',
				lastOperation,
				originalOutageCause,
				state: getLifecycleState(),
				toolVmPlane: 'unknown',
			}),
		getLogs: async () => {
			const activeGateway = requireGateway();
			return await (options.runControllerLogs ?? runControllerLogsDefault)(
				{ zoneId: options.zone.id },
				{
					readGatewayLogs: async () =>
						(
							await activeGateway.vm.exec(
								buildManagedGatewayCombinedLogsCommand(activeGateway.bootContract),
							)
						).stdout,
				},
			);
		},
		getLifecycleState,
		getSnapshot: () => {
			const currentLifecycleState = getLifecycleState();
			if (currentLifecycleState.kind === 'running') {
				const hostPid = currentLifecycleState.gateway.vm.getHostProcessId();
				if (hostPid === undefined || hostPid === null) {
					const missingHostPidState = markGatewayHostPidMissing(
						`Gateway VM host pid is unavailable for zone '${options.zone.id}'.`,
					);
					return {
						lastError: missingHostPidState.error.message,
						lifecycleState: 'failed',
					};
				}
				return {
					...(bootedAt ? { bootedAt } : {}),
					gateway: {
						ingress: currentLifecycleState.gateway.ingress,
						vm: {
							hostPid,
							id: currentLifecycleState.gateway.vm.id,
						},
					},
					...(lastError ? { lastError } : {}),
					lifecycleState: 'running',
				};
			}
			return lastError ? { lastError, lifecycleState: 'failed' } : { lifecycleState: 'stopped' };
		},
		refreshCredentials: async (refreshOptions = {}) =>
			await (async () => {
				const operationId = createOperationId('credentials-refresh');
				const operationTrigger = 'credentials-refresh';
				await recordLifecycleOperation({
					kind: 'credentials-refresh-requested',
					operationId,
					operationTrigger,
					previousGateway: gatewayIdentityFor(gateway),
				});
				const failCredentialsRefreshSecretResolution = async (error: unknown): Promise<never> => {
					const classifiedError = {
						code: 'secret-resolution-failed',
						message: formatUnknownError(error),
					} as const;
					const currentLifecycleState = getLifecycleState();
					lastError = classifiedError.message;
					if (
						currentLifecycleState.kind !== 'running' &&
						currentLifecycleState.kind !== 'running-degraded'
					) {
						lifecycleState = {
							coldStartEligible: true,
							error: classifiedError,
							kind: 'failed',
						};
					}
					await recordLifecycleOperation({
						errorCode: classifiedError.code,
						errorMessage: classifiedError.message,
						kind: 'operation-failed',
						operationId,
						operationTrigger,
						previousGateway: gatewayIdentityFor(gateway),
					});
					throw new ControllerZoneRuntimeStartError(options.zone.id, error, {
						gatewayLifecycleErrorCode: classifiedError.code,
						operationId,
					});
				};
				let refreshedSecretResolver: SecretResolver;
				try {
					refreshedSecretResolver = options.createFreshSecretResolver
						? await options.createFreshSecretResolver()
						: options.secretResolver;
				} catch (error) {
					await failCredentialsRefreshSecretResolution(error);
				}
				if (refreshOptions.signal?.aborted) {
					throw refreshOptions.signal.reason;
				}
				let preflightedRefreshStartOptions: GatewayZoneStartOptions | undefined;
				return await (
					options.runControllerCredentialsRefresh ?? runControllerCredentialsRefreshDefault
				)(
					{ zoneId: options.zone.id },
					{
						refreshZoneSecrets: async () => {
							try {
								preflightedRefreshStartOptions = await preflightGatewayStartOptions(
									{ secretResolver: refreshedSecretResolver },
									{ operationId, operationTrigger },
								);
							} catch (error) {
								await failCredentialsRefreshSecretResolution(error);
							}
							if (refreshOptions.signal?.aborted) {
								throw refreshOptions.signal.reason;
							}
						},
						restartGatewayZone: async () => {
							if (refreshOptions.signal?.aborted) {
								throw refreshOptions.signal.reason;
							}
							const currentLifecycleState = getLifecycleState();
							if (
								currentLifecycleState.kind === 'running' ||
								currentLifecycleState.kind === 'running-degraded'
							) {
								await restartWithStartOptions(
									{ timeoutMs: refreshOptions.timeoutMs },
									preflightedRefreshStartOptions ?? { secretResolver: refreshedSecretResolver },
									{ operationId, operationTrigger },
								);
								return;
							}
							await coldStartWithStartOptions(
								{ timeoutMs: refreshOptions.timeoutMs },
								preflightedRefreshStartOptions ?? { secretResolver: refreshedSecretResolver },
								{ operationId, operationTrigger },
							);
						},
					},
				);
			})(),
		restart,
		shutdown,
		start,
		stop,
		upgrade: async () =>
			await (options.runControllerUpgrade ?? runControllerUpgradeDefault)(
				{ systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					rebuildGatewayImage: async () => {},
					restartGatewayZone: async () => {
						await restart({ operationTrigger: 'upgrade' });
					},
				},
			),
		zoneId: options.zone.id,
	};
}
