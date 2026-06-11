import { randomUUID } from 'node:crypto';

import type { GatewayHealthCheck } from '@agent-vm/gateway-interface';
import type { BuildImageResult } from '@agent-vm/gondolin-adapter';
import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { runGatewayHealthCheck } from '../../gateway/gateway-health-check.js';
import { GatewayOwnershipUnsafeError } from '../../gateway/gateway-ownership-evidence.js';
import { deleteGatewayRuntimeRecord as deleteGatewayRuntimeRecordDefault } from '../../gateway/gateway-runtime-record.js';
import {
	preflightGatewayZoneStart as preflightGatewayZoneStartDefault,
	startGatewayZone,
} from '../../gateway/gateway-zone-orchestrator.js';
import type {
	GatewayZoneStartResult,
	StartGatewayZoneOptions as StartGatewayZoneRequestOptions,
} from '../../gateway/gateway-zone-support.js';
import { runControllerCredentialsRefresh as runControllerCredentialsRefreshDefault } from '../../operations/credentials-refresh.js';
import { runControllerDestroy as runControllerDestroyDefault } from '../../operations/destroy-zone.js';
import { runControllerUpgrade as runControllerUpgradeDefault } from '../../operations/upgrade-zone.js';
import { runControllerLogs as runControllerLogsDefault } from '../../operations/zone-logs.js';
import { isProcessAlive as defaultIsProcessAlive } from '../../shared/managed-vm-process.js';
import type { LeaseManager } from '../leases/lease-manager.js';
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
	OpenClawZoneRuntime,
	OpenClawZoneRestartOptions,
	OpenClawZoneRestartResult,
} from './zone-runtime-types.js';

type OpenClawZoneConfig = ControllerZoneConfig & {
	readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'openclaw' }>;
};

export interface CreateOpenClawZoneRuntimeOptions {
	readonly clearTimeoutImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
	readonly closeGatewayTimeoutMs?: number | undefined;
	readonly createFreshSecretResolver?: (() => Promise<SecretResolver>) | undefined;
	readonly deleteGatewayRuntimeRecord?: (stateDirectory: string) => Promise<void>;
	readonly appendGatewayLifecycleOperationRecord?: (
		record: GatewayLifecycleOperationRecord,
	) => Promise<void>;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly leaseManager: Pick<LeaseManager, 'listLeases' | 'releaseLease'>;
	readonly now: () => number;
	readonly preflightGatewayZoneStart?: typeof preflightGatewayZoneStartDefault;
	readonly restartGatewayZone?: (
		zoneId: string,
		options?: GatewayZoneStartOptions,
	) => Promise<GatewayZoneStartResult>;
	readonly runControllerCredentialsRefresh?: typeof runControllerCredentialsRefreshDefault;
	readonly runControllerDestroy?: typeof runControllerDestroyDefault;
	readonly runControllerLogs?: typeof runControllerLogsDefault;
	readonly runControllerUpgrade?: typeof runControllerUpgradeDefault;
	readonly secretResolver: SecretResolver;
	readonly setTimeoutImpl?: ((callback: () => void, delayMs: number) => NodeJS.Timeout) | undefined;
	readonly systemConfig: LoadedSystemConfig;
	readonly zone: OpenClawZoneConfig;
}

const defaultGatewayCloseTimeoutMs = 60_000;

interface GatewayZoneStartOptions {
	readonly observabilityStartupCheck?: 'default' | 'skip';
	readonly prebuiltImage?: BuildImageResult | undefined;
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

function isRecoverySecretResolutionFailure(
	record: Pick<GatewayLifecycleOperationRecord, 'errorCode' | 'operationTrigger'>,
): boolean {
	return (
		record.errorCode === 'secret-resolution-failed' &&
		(record.operationTrigger === 'auto-recovery' ||
			record.operationTrigger === 'credentials-refresh')
	);
}

class OpenClawZoneRestartTimeoutError extends Error {
	readonly code = 'OPENCLAW_GATEWAY_RESTART_TIMEOUT';

	constructor(zoneId: string, timeoutMs: number) {
		super(`OpenClaw gateway restart timed out for zone '${zoneId}' after ${timeoutMs}ms`);
		this.name = 'OpenClawZoneRestartTimeoutError';
	}
}

export function isOpenClawZoneRestartTimeoutError(
	error: unknown,
): error is OpenClawZoneRestartTimeoutError {
	return (
		error instanceof Error && 'code' in error && error.code === 'OPENCLAW_GATEWAY_RESTART_TIMEOUT'
	);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildOpenClawCombinedLogsCommand(logPath: string): string {
	return [
		`echo '===== gateway boot log (${logPath}) ====='`,
		`cat ${logPath} 2>/dev/null || true`,
		'echo',
		"echo '===== latest openclaw runtime log (/agent-vm/logs/*.log) ====='",
		'latest_openclaw_log=$(ls -1t /agent-vm/logs/*.log 2>/dev/null | grep -v "/gateway-boot-latest\\.log$" | head -n 1); if [ -n "$latest_openclaw_log" ]; then tail -n 400 "$latest_openclaw_log"; fi',
	].join('; ');
}

function writeOpenClawZoneRuntimeLog(message: string): void {
	process.stderr.write(`[openclaw-zone-runtime] ${message}\n`);
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
	const hostPid = runtimeGateway.vm.getHostPid();
	return {
		...(typeof hostPid === 'number' && hostPid > 0 ? { hostPid } : {}),
		vmId: runtimeGateway.vm.id,
	};
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

export function createOpenClawZoneRuntime(
	options: CreateOpenClawZoneRuntimeOptions,
): OpenClawZoneRuntime {
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const closeGatewayTimeoutMs = options.closeGatewayTimeoutMs ?? defaultGatewayCloseTimeoutMs;
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
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

	const startGateway = async (
		startOptions: GatewayZoneStartOptions = {},
	): Promise<GatewayZoneStartResult> =>
		options.restartGatewayZone
			? await options.restartGatewayZone(options.zone.id, startOptions)
			: await startGatewayZone({
					...(startOptions.observabilityStartupCheck
						? { observabilityStartupCheck: startOptions.observabilityStartupCheck }
						: {}),
					...(startOptions.prebuiltImage ? { prebuiltImage: startOptions.prebuiltImage } : {}),
					...(startOptions.runtimeEnvironment
						? { runtimeEnvironment: startOptions.runtimeEnvironment }
						: {}),
					...(startOptions.runtimePluginConfigs
						? { runtimePluginConfigs: startOptions.runtimePluginConfigs }
						: {}),
					secretResolver: startOptions.secretResolver ?? options.secretResolver,
					systemConfig: options.systemConfig,
					zoneId: options.zone.id,
				});

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
			gatewayType: 'openclaw',
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
				runtimeDir: options.systemConfig.runtimeDir,
				zoneId: options.zone.id,
			});
		} catch (error) {
			writeOpenClawZoneRuntimeLog(
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
			await closeGatewayWithDeadline(staleGateway);
			await recordLifecycleOperation({
				kind: 'vm-close-finished',
				operationId: operationContext.operationId,
				operationTrigger: operationContext.operationTrigger,
				previousGateway: gatewayIdentityFor(staleGateway),
			});
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
			const hostPid = lifecycleState.gateway.vm.getHostPid();
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
		readonly operation: Promise<TResult>;
		readonly timeoutMs: number;
	}): { readonly lock: Promise<unknown>; readonly publicResult: Promise<TResult> } => {
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeoutImpl(() => {
				lifecycleGeneration += 1;
				reject(new OpenClawZoneRestartTimeoutError(options.zone.id, props.timeoutMs));
			}, props.timeoutMs);
			timeout.unref?.();
		});
		const publicResult = Promise.race([props.operation, timeoutPromise]).finally(() => {
			if (timeout) {
				clearTimeoutImpl(timeout);
			}
		});
		return {
			lock: props.operation.then(
				() => undefined,
				() => undefined,
			),
			publicResult,
		};
	};

	const releaseZoneLeases = async (
		zoneId: string,
	): Promise<{ readonly failedLeaseIds: readonly string[] }> => {
		const leases = options.leaseManager
			.listLeases()
			.filter((activeLease) => activeLease.zoneId === zoneId);
		const releaseResults = await Promise.allSettled(
			leases.map(
				async (lease) => await options.leaseManager.releaseLease(lease.id, { force: true }),
			),
		);
		const failedLeaseIds: string[] = [];
		for (const [index, releaseResult] of releaseResults.entries()) {
			if (releaseResult.status === 'fulfilled') {
				continue;
			}
			const leaseId = leases[index]?.id ?? `(unknown lease at index ${index})`;
			failedLeaseIds.push(leaseId);
			writeOpenClawZoneRuntimeLog(
				`lease '${leaseId}' release failed while restarting zone '${zoneId}': ${formatUnknownError(releaseResult.reason)}`,
			);
		}
		return { failedLeaseIds };
	};

	const closeGatewayWithDeadline = async (
		activeGateway: GatewayZoneRuntimeHandle,
	): Promise<void> => {
		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				activeGateway.vm.close(),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeoutImpl(() => {
						reject(
							new Error(
								`Gateway VM close timed out for zone '${options.zone.id}' after ${closeGatewayTimeoutMs}ms`,
							),
						);
					}, closeGatewayTimeoutMs);
					timeout.unref?.();
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeoutImpl(timeout);
			}
		}
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
		throw new OpenClawZoneRestartTimeoutError(options.zone.id, props.timeoutMs ?? 0);
	};

	const stopNow = async (
		next: 'stopped' | 'starting' = 'stopped',
		operationContext?: GatewayLifecycleOperationContext,
	): Promise<void> => {
		const activeGateway = gateway;
		const operationId = operationContext?.operationId ?? createOperationId('stop');
		const operationTrigger = operationContext?.operationTrigger ?? 'operator-stop';
		const previousGateway = operationContext?.previousGateway ?? activeGateway;
		lifecycleState = {
			kind: 'stopping',
			next,
			operationId,
			previousGateway,
		};
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
				await closeGatewayWithDeadline(activeGateway);
				await recordLifecycleOperation({
					kind: 'vm-close-finished',
					operationId,
					operationTrigger,
					previousGateway: gatewayIdentityFor(previousGateway),
				});
			}
			await (options.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecordDefault)(
				options.zone.gateway.stateDir,
			);
			await recordLifecycleOperation({
				kind: 'runtime-record-deleted',
				operationId,
				operationTrigger,
				previousGateway: gatewayIdentityFor(previousGateway),
			});
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
			const startedGateway = await startGateway(startOptions);
			if (expectedGeneration !== undefined && expectedGeneration !== lifecycleGeneration) {
				try {
					await closeGatewayWithDeadline(startedGateway);
					if (lifecycleGeneration === expectedGeneration + 1) {
						await (options.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecordDefault)(
							options.zone.gateway.stateDir,
						);
						await recordLifecycleOperation({
							currentGateway: gatewayIdentityFor(startedGateway),
							kind: 'runtime-record-deleted',
							operationId,
							operationTrigger,
							previousGateway: gatewayIdentityFor(operationContext?.previousGateway),
						});
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
					writeOpenClawZoneRuntimeLog(
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
			const preflightGatewayZoneStart =
				options.preflightGatewayZoneStart ?? preflightGatewayZoneStartDefault;
			const preflightResult = await preflightGatewayZoneStart({
				...(startOptions.runtimeEnvironment
					? { runtimeEnvironment: startOptions.runtimeEnvironment }
					: {}),
				...(startOptions.runtimePluginConfigs
					? { runtimePluginConfigs: startOptions.runtimePluginConfigs }
					: {}),
				secretResolver: startOptions.secretResolver ?? options.secretResolver,
				systemConfig: options.systemConfig,
				zoneId: options.zone.id,
			});
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

	const stop = async (): Promise<void> => await runLifecycleOperation(async () => await stopNow());

	const start = async (): Promise<void> =>
		await runLifecycleOperation(
			async () =>
				await startNow(
					undefined,
					{},
					{
						operationId: createOperationId('start'),
						operationTrigger: 'controller-start',
					},
				),
		);

	const restartWithStartOptions = async (
		restartOptions: OpenClawZoneRestartOptions = {},
		startOptions: GatewayZoneStartOptions = {},
		operationMetadata: {
			readonly operationId?: string | undefined;
			readonly operationTrigger?: GatewayLifecycleOperationTrigger | undefined;
		} = {},
	): Promise<OpenClawZoneRestartResult> => {
		return await runLifecycleOperation<OpenClawZoneRestartResult>(async () => {
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
			const restartOperation =
				currentState.kind === 'running' || currentState.kind === 'running-degraded'
					? (async (): Promise<OpenClawZoneRestartResult> => {
							await recordLifecycleOperation({
								kind: 'restart-requested',
								operationId,
								operationTrigger: operationContext.operationTrigger,
								previousGateway: gatewayIdentityFor(operationContext.previousGateway),
							});
							const preflightedStartOptions = await preflightGatewayStartOptions(
								startOptions,
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
							const leaseReleaseResult = await releaseZoneLeases(options.zone.id);
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
								throw new OpenClawZoneRestartTimeoutError(
									options.zone.id,
									restartOptions.timeoutMs ?? 0,
								);
							}
							return {
								leaseReleaseFailureCount: leaseReleaseResult.failedLeaseIds.length,
								operationId,
							};
						})()
					: (async (): Promise<OpenClawZoneRestartResult> => {
							await recordLifecycleOperation({
								kind: 'cold-start-requested',
								operationId,
								operationTrigger: operationContext.operationTrigger,
							});
							const preflightedStartOptions = await preflightGatewayStartOptions(
								startOptions,
								operationContext,
							);
							await abortIfLifecycleGenerationStale({
								operationContext,
								operationGeneration,
								stage: 'lease release',
								timeoutMs: restartOptions.timeoutMs,
							});
							const leaseReleaseResult = await releaseZoneLeases(options.zone.id);
							await abortIfLifecycleGenerationStale({
								operationContext,
								operationGeneration,
								stage: 'stale gateway close',
								timeoutMs: restartOptions.timeoutMs,
							});
							await closeStaleGatewayBeforeColdStart(operationContext);
							await startNow(operationGeneration, preflightedStartOptions, operationContext);
							if (operationGeneration !== lifecycleGeneration) {
								throw new OpenClawZoneRestartTimeoutError(
									options.zone.id,
									restartOptions.timeoutMs ?? 0,
								);
							}
							return {
								leaseReleaseFailureCount: leaseReleaseResult.failedLeaseIds.length,
								operationId,
							};
						})();

			if (restartOptions.timeoutMs === undefined) {
				return await restartOperation;
			}

			return withLifecycleTimeout({
				operation: restartOperation,
				timeoutMs: restartOptions.timeoutMs,
			});
		});
	};

	const restart = async (
		restartOptions: OpenClawZoneRestartOptions = {},
	): Promise<OpenClawZoneRestartResult> => await restartWithStartOptions(restartOptions);

	const coldStartWithStartOptions = async (
		restartOptions: OpenClawZoneRestartOptions = {},
		startOptions: GatewayZoneStartOptions = {},
		operationMetadata: {
			readonly operationId?: string | undefined;
			readonly operationTrigger?: GatewayLifecycleOperationTrigger | undefined;
		} = {},
	): Promise<OpenClawZoneRestartResult> => {
		return await runLifecycleOperation<OpenClawZoneRestartResult>(async () => {
			lifecycleGeneration += 1;
			const operationGeneration = lifecycleGeneration;
			const operationContext: GatewayLifecycleOperationContext = {
				operationId: operationMetadata.operationId ?? createOperationId('cold-start'),
				operationTrigger:
					operationMetadata.operationTrigger ?? restartOptions.operationTrigger ?? 'auto-recovery',
			};
			const coldStartOperation = (async (): Promise<OpenClawZoneRestartResult> => {
				getLifecycleState();
				await recordLifecycleOperation({
					kind: 'cold-start-requested',
					operationId: operationContext.operationId,
					operationTrigger: operationContext.operationTrigger,
				});
				const preflightedStartOptions = await preflightGatewayStartOptions(
					startOptions,
					operationContext,
				);
				await abortIfLifecycleGenerationStale({
					operationContext,
					operationGeneration,
					stage: 'lease release',
					timeoutMs: restartOptions.timeoutMs,
				});
				const leaseReleaseResult = await releaseZoneLeases(options.zone.id);
				await abortIfLifecycleGenerationStale({
					operationContext,
					operationGeneration,
					stage: 'stale gateway close',
					timeoutMs: restartOptions.timeoutMs,
				});
				await closeStaleGatewayBeforeColdStart(operationContext);
				await startNow(operationGeneration, preflightedStartOptions, operationContext);
				if (operationGeneration !== lifecycleGeneration) {
					throw new OpenClawZoneRestartTimeoutError(options.zone.id, restartOptions.timeoutMs ?? 0);
				}
				return {
					leaseReleaseFailureCount: leaseReleaseResult.failedLeaseIds.length,
					operationId: operationContext.operationId,
				};
			})();

			if (restartOptions.timeoutMs === undefined) {
				return await coldStartOperation;
			}

			return withLifecycleTimeout({
				operation: coldStartOperation,
				timeoutMs: restartOptions.timeoutMs,
			});
		});
	};

	const coldStart = async (
		restartOptions: OpenClawZoneRestartOptions = {},
	): Promise<OpenClawZoneRestartResult> => await coldStartWithStartOptions(restartOptions);

	return {
		coldStart,
		destroy: async (purge) =>
			await (options.runControllerDestroy ?? runControllerDestroyDefault)(
				{ purge, systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					releaseZoneLeases: async (zoneId) => {
						await releaseZoneLeases(zoneId);
					},
					stopGatewayZone: async () => await stop(),
				},
			),
		enableSsh: async () => await requireGateway().vm.enableSsh(),
		exec: async (command) => await executeGatewayCommand(requireGateway(), command),
		gatewayType: 'openclaw',
		getHealth: async () => {
			getLifecycleState();
			const activeGateway = requireGateway();
			return await runGatewayHealthProbe(activeGateway, activeGateway.processSpec.healthCheck);
		},
		getServiceHealth: async () => {
			getLifecycleState();
			const activeGateway = requireGateway();
			return await runGatewayHealthProbe(
				activeGateway,
				activeGateway.processSpec.serviceHealthCheck ?? activeGateway.processSpec.healthCheck,
			);
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
								buildOpenClawCombinedLogsCommand(activeGateway.processSpec.logPath),
							)
						).stdout,
				},
			);
		},
		getLifecycleState,
		getSnapshot: () => {
			const currentLifecycleState = getLifecycleState();
			if (currentLifecycleState.kind === 'running') {
				const hostPid = currentLifecycleState.gateway.vm.getHostPid();
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
		refreshCredentials: async () =>
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
						},
						restartGatewayZone: async () => {
							const currentLifecycleState = getLifecycleState();
							if (
								currentLifecycleState.kind === 'running' ||
								currentLifecycleState.kind === 'running-degraded'
							) {
								await restartWithStartOptions(
									{},
									preflightedRefreshStartOptions ?? { secretResolver: refreshedSecretResolver },
									{ operationId, operationTrigger },
								);
								return;
							}
							await coldStartWithStartOptions(
								{},
								preflightedRefreshStartOptions ?? { secretResolver: refreshedSecretResolver },
								{ operationId, operationTrigger },
							);
						},
					},
				);
			})(),
		restart,
		shutdown: stop,
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
