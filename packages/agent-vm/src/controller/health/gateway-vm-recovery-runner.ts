import { redactOnePasswordReferences } from '@agent-vm/secret-management';

import type { ControllerRuntimeReadiness } from '../http/controller-http-route-support.js';
import type { GatewayZoneLifecycleState } from '../zone-runtimes/gateway-zone-state-machine.js';
import { isOpenClawZoneRestartTimeoutError } from '../zone-runtimes/openclaw-zone-runtime.js';
import { ControllerZoneRuntimeStartError } from '../zone-runtimes/zone-runtime-errors.js';
import type { OpenClawZoneRestartResult } from '../zone-runtimes/zone-runtime-types.js';
import { classifyGatewayRecoveryAction } from './gateway-recovery-actions.js';
import type {
	GatewayVmRecoveryRequest,
	GatewayVmRecoveryResult,
} from './gateway-service-health-monitor.js';
import type { GatewayVmRecoverySourceKey } from './gateway-vm-recovery-policy.js';

export interface CreateGatewayVmRecoveryRunnerOptions {
	readonly clearTimeoutImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
	readonly getRecoverableGatewayRuntime: (zoneId: string) => RecoverableGatewayRuntime;
	readonly getRuntimeReadiness: () => ControllerRuntimeReadiness;
	readonly now: () => number;
	readonly restartTimeoutMs: number;
	readonly setTimeoutImpl?: ((callback: () => void, delayMs: number) => NodeJS.Timeout) | undefined;
	readonly writeLog: (message: string) => void;
}

function gatewayRecoverySourceKeysEqual(
	left: GatewayVmRecoverySourceKey,
	right: GatewayVmRecoverySourceKey,
): boolean {
	return (
		left.bootId === right.bootId &&
		left.domain === right.domain &&
		left.gatewayVmId === right.gatewayVmId &&
		left.generationId === right.generationId &&
		left.zoneId === right.zoneId
	);
}

export interface RecoverableGatewayRuntime {
	readonly coldStart: (options: {
		readonly operationTrigger: 'auto-recovery';
		readonly timeoutMs: number;
	}) => Promise<OpenClawZoneRestartResult>;
	readonly getLifecycleState: () => GatewayZoneLifecycleState;
	readonly getSnapshot: () => {
		readonly bootedAt?: string | undefined;
		readonly gateway?:
			| {
					readonly vm: { readonly hostPid?: number | undefined; readonly id: string };
			  }
			| undefined;
		readonly lifecycleState: 'failed' | 'running' | 'stopped';
	};
	readonly refreshCredentials: (options?: {
		readonly signal?: AbortSignal | undefined;
		readonly timeoutMs?: number | undefined;
	}) => Promise<{ readonly ok: true; readonly zoneId: string }>;
	readonly restart: (options: {
		readonly operationTrigger: 'auto-recovery';
		readonly timeoutMs: number;
	}) => Promise<OpenClawZoneRestartResult>;
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return typeof error === 'string' ? error : JSON.stringify(error);
}

const serviceAccountTokenEnvPattern = /\b(OP_SERVICE_ACCOUNT_TOKEN=)[^\s;]+/gu;
const onePasswordServiceAccountTokenPattern = /\bops_[A-Za-z0-9._=-]{16,}\b/gu;
const bearerCredentialPattern = /\b(Bearer\s+)[^\s;,'")]+/giu;
const credentialAssignmentPattern =
	/(["']?)(password|passwd|token|secret)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s;,'")]+)/giu;

function redactCredentialAssignment(
	_match: string,
	keyQuote: string,
	keyName: string,
	separator: string,
	value: string,
): string {
	const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
	return `${keyQuote}${keyName}${keyQuote}${separator}${valueQuote}<redacted>${valueQuote}`;
}

function formatRecoveryLogError(error: unknown): string {
	return redactOnePasswordReferences(formatUnknownError(error))
		.replaceAll(serviceAccountTokenEnvPattern, '$1<redacted>')
		.replaceAll(onePasswordServiceAccountTokenPattern, '<redacted>')
		.replaceAll(bearerCredentialPattern, '$1<redacted>')
		.replaceAll(credentialAssignmentPattern, redactCredentialAssignment);
}

function getUnknownErrorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return undefined;
	}
	return typeof error.code === 'string' ? error.code : undefined;
}

export function classifyGatewayRecoveryRestartError(error: unknown): string {
	if (
		error instanceof ControllerZoneRuntimeStartError &&
		error.gatewayLifecycleErrorCode !== undefined
	) {
		return error.gatewayLifecycleErrorCode;
	}
	if (isOpenClawZoneRestartTimeoutError(error)) {
		return 'recovery-timeout';
	}
	const code = getUnknownErrorCode(error);
	if (
		code === 'EACCES' ||
		code === 'EIO' ||
		code === 'ENOENT' ||
		code === 'ENOSPC' ||
		code === 'EROFS'
	) {
		return 'restart-disk-failure';
	}
	const message = formatUnknownError(error).toLowerCase();
	if (message.includes('gateway recovery action deadline exceeded')) {
		return 'recovery-timeout';
	}
	if (
		message.includes('1password') ||
		message.includes('credential') ||
		message.includes('op://') ||
		message.includes('secret')
	) {
		return 'restart-secret-failure';
	}
	if (message.includes('gondolin') || message.includes('qemu') || message.includes('vm.create')) {
		return 'restart-vm-create-failed';
	}
	return 'restart-threw';
}

function operationIdForRecoveryError(error: unknown): string | undefined {
	return error instanceof ControllerZoneRuntimeStartError ? error.operationId : undefined;
}

function classifyGatewayRecoveryRuntimeError(
	runtime: RecoverableGatewayRuntime,
	error: unknown,
): string {
	const lifecycleState = runtime.getLifecycleState();
	if (lifecycleState.kind === 'failed' && lifecycleState.error.code === 'owner-unsafe') {
		return 'owner-unsafe';
	}
	if (lifecycleState.kind === 'owner-unsafe') {
		return 'owner-unsafe';
	}
	return classifyGatewayRecoveryRestartError(error);
}

export function createGatewayVmRecoveryRunner(
	options: CreateGatewayVmRecoveryRunnerOptions,
): (request: GatewayVmRecoveryRequest) => Promise<GatewayVmRecoveryResult> {
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const runWithDeadline = async <TResult>(
		operation: Promise<TResult>,
		onTimeout?: () => void,
	): Promise<TResult> => {
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeoutImpl(() => {
				onTimeout?.();
				reject(new Error('gateway recovery action deadline exceeded'));
			}, options.restartTimeoutMs);
			timeout.unref?.();
		});
		try {
			return await Promise.race([operation, timeoutPromise]);
		} finally {
			if (timeout !== undefined) {
				clearTimeoutImpl(timeout);
			}
		}
	};
	return async (request): Promise<GatewayVmRecoveryResult> => {
		const startedAtMs = options.now();
		const elapsedMs = (): number => options.now() - startedAtMs;
		if (options.getRuntimeReadiness().state === 'stopping') {
			return {
				action: 'observe-only',
				elapsedMs: elapsedMs(),
				errorCode: 'controller-stopping',
				result: 'failed',
			};
		}

		let runtime: RecoverableGatewayRuntime;
		try {
			runtime = options.getRecoverableGatewayRuntime(request.zoneId);
		} catch (error) {
			options.writeLog(
				`Gateway VM recovery failed to find OpenClaw runtime for zone '${request.zoneId}': ${formatRecoveryLogError(error)}`,
			);
			return {
				action: 'observe-only',
				elapsedMs: elapsedMs(),
				errorCode: 'runtime-unavailable',
				result: 'failed',
			};
		}

		const oldSnapshot = runtime.getSnapshot();
		const lifecycleState = runtime.getLifecycleState();
		if (lifecycleState.kind === 'running' || lifecycleState.kind === 'running-degraded') {
			const currentSourceKey = lifecycleState.gateway.controlSessionRecoverySourceKey;
			if (
				request.sourceKey === undefined ||
				request.sourceKey.zoneId !== request.zoneId ||
				currentSourceKey === undefined ||
				!gatewayRecoverySourceKeysEqual(currentSourceKey, request.sourceKey)
			) {
				return {
					action: 'observe-only',
					elapsedMs: elapsedMs(),
					errorCode: 'stale-recovery-source',
					result: 'failed',
				};
			}
		}
		const recoveryAction = classifyGatewayRecoveryAction({
			lifecycleState,
			recoveryDecision: {
				consecutiveFailures: request.consecutiveFailures,
				kind: 'restart',
				reason: request.reason,
				zoneId: request.zoneId,
			},
		});
		if (recoveryAction.kind === 'refresh-secret-resolver') {
			options.writeLog(
				`Refreshing gateway secret resolver for zone '${request.zoneId}' after ${request.consecutiveFailures} consecutive ${request.reason} observations.`,
			);
			const refreshAbortController = new AbortController();
			try {
				await runWithDeadline(
					runtime.refreshCredentials({
						signal: refreshAbortController.signal,
						timeoutMs: options.restartTimeoutMs,
					}),
					() =>
						refreshAbortController.abort(new Error('gateway recovery action deadline exceeded')),
				);
			} catch (error) {
				options.writeLog(
					`Gateway VM recovery credential refresh failed for zone '${request.zoneId}': ${formatRecoveryLogError(error)}`,
				);
				return {
					action: 'gateway-vm-cold-start',
					elapsedMs: elapsedMs(),
					errorCode: classifyGatewayRecoveryRuntimeError(runtime, error),
					...(operationIdForRecoveryError(error) === undefined
						? {}
						: { operationId: operationIdForRecoveryError(error) }),
					result: 'failed',
				};
			}
			return verifyColdStartRecovery({
				elapsedMs,
				leaseReleaseFailureCount: 0,
				operationId: undefined,
				runtime,
			});
		}
		if (recoveryAction.kind === 'cold-start-gateway') {
			options.writeLog(
				`Auto cold-starting gateway VM for zone '${request.zoneId}' after ${request.consecutiveFailures} consecutive ${request.reason} observations.`,
			);
			let coldStartResult: OpenClawZoneRestartResult;
			try {
				coldStartResult = await runWithDeadline(
					runtime.coldStart({
						operationTrigger: 'auto-recovery',
						timeoutMs: options.restartTimeoutMs,
					}),
				);
			} catch (error) {
				options.writeLog(
					`Gateway VM recovery cold-start failed for zone '${request.zoneId}': ${formatRecoveryLogError(error)}`,
				);
				return {
					action: 'gateway-vm-cold-start',
					elapsedMs: elapsedMs(),
					errorCode: classifyGatewayRecoveryRuntimeError(runtime, error),
					...(operationIdForRecoveryError(error) === undefined
						? {}
						: { operationId: operationIdForRecoveryError(error) }),
					result: 'failed',
				};
			}
			return verifyColdStartRecovery({
				elapsedMs,
				leaseReleaseFailureCount: coldStartResult.leaseReleaseFailureCount,
				operationId: coldStartResult.operationId,
				runtime,
			});
		}
		if (oldSnapshot.lifecycleState !== 'running' || !oldSnapshot.gateway) {
			const failedAction =
				recoveryAction.kind === 'operator-required'
					? 'operator-required'
					: recoveryAction.kind === 'observe-only'
						? 'observe-only'
						: 'operator-required';
			return {
				action: failedAction,
				elapsedMs: elapsedMs(),
				errorCode:
					recoveryAction.kind === 'operator-required'
						? recoveryAction.reason
						: recoveryAction.kind === 'observe-only'
							? recoveryAction.reason
							: 'old-gateway-not-running',
				result: 'failed',
			};
		}
		const oldGateway = oldSnapshot.gateway;
		const oldBootedAt = oldSnapshot.bootedAt;
		const oldHostPid = oldGateway.vm.hostPid;
		options.writeLog(
			`Auto-restarting gateway VM for zone '${request.zoneId}' after ${request.consecutiveFailures} consecutive ${request.reason} observations.`,
		);

		let restartResult: OpenClawZoneRestartResult;
		try {
			restartResult = await runWithDeadline(
				runtime.restart({
					operationTrigger: 'auto-recovery',
					timeoutMs: options.restartTimeoutMs,
				}),
			);
		} catch (error) {
			options.writeLog(
				`Gateway VM recovery restart failed for zone '${request.zoneId}': ${formatRecoveryLogError(error)}`,
			);
			return {
				action: 'gateway-vm-restart',
				elapsedMs: elapsedMs(),
				errorCode: classifyGatewayRecoveryRuntimeError(runtime, error),
				...(oldBootedAt === undefined ? {} : { oldBootedAt }),
				...(oldHostPid === undefined ? {} : { oldHostPid }),
				oldVmId: oldGateway.vm.id,
				...(operationIdForRecoveryError(error) === undefined
					? {}
					: { operationId: operationIdForRecoveryError(error) }),
				result: 'failed',
			};
		}

		const newSnapshot = runtime.getSnapshot();
		const newBootedAt = newSnapshot.bootedAt;
		const newGateway = newSnapshot.gateway;
		if (
			newSnapshot.lifecycleState !== 'running' ||
			!newGateway ||
			oldBootedAt === undefined ||
			newBootedAt === undefined ||
			oldHostPid === undefined ||
			newGateway.vm.hostPid === undefined ||
			newGateway.vm.id === oldGateway.vm.id ||
			newGateway.vm.hostPid === oldHostPid ||
			newBootedAt === oldBootedAt
		) {
			return {
				action: 'gateway-vm-restart',
				elapsedMs: elapsedMs(),
				errorCode: 'restart-verification-failed',
				...(oldBootedAt === undefined ? {} : { oldBootedAt }),
				...(oldHostPid === undefined ? {} : { oldHostPid }),
				oldVmId: oldGateway.vm.id,
				result: 'failed',
			};
		}
		return {
			elapsedMs: elapsedMs(),
			leaseReleaseFailureCount: restartResult.leaseReleaseFailureCount,
			newBootedAt,
			newHostPid: newGateway.vm.hostPid,
			newVmId: newGateway.vm.id,
			oldBootedAt,
			oldHostPid,
			oldVmId: oldGateway.vm.id,
			...(restartResult.operationId === undefined
				? {}
				: { operationId: restartResult.operationId }),
			result: 'ok',
		};
	};
}

function verifyColdStartRecovery(options: {
	readonly elapsedMs: () => number;
	readonly leaseReleaseFailureCount: number;
	readonly operationId?: string | undefined;
	readonly runtime: Pick<RecoverableGatewayRuntime, 'getSnapshot'>;
}): GatewayVmRecoveryResult {
	const newSnapshot = options.runtime.getSnapshot();
	const newBootedAt = newSnapshot.bootedAt;
	const newGateway = newSnapshot.gateway;
	if (
		newSnapshot.lifecycleState !== 'running' ||
		!newGateway ||
		newBootedAt === undefined ||
		newGateway.vm.hostPid === undefined
	) {
		return {
			action: 'gateway-vm-cold-start',
			elapsedMs: options.elapsedMs(),
			errorCode: 'cold-start-verification-failed',
			result: 'failed',
		};
	}
	return {
		action: 'gateway-vm-cold-start',
		elapsedMs: options.elapsedMs(),
		leaseReleaseFailureCount: options.leaseReleaseFailureCount,
		newBootedAt,
		newHostPid: newGateway.vm.hostPid,
		newVmId: newGateway.vm.id,
		...(options.operationId === undefined ? {} : { operationId: options.operationId }),
		result: 'ok',
	};
}
