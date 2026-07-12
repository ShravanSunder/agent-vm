import { randomUUID } from 'node:crypto';

import type { GatewayProcessSpec } from '@agent-vm/gateway-interface';

import {
	deriveGatewayControlSessionMaterialForProcess,
	type GatewayControlSessionMaterial,
} from '../controller/control-session/gateway-control-session.js';
import type { GatewayDisposableControlSessionClient } from '../controller/control-session/gateway-disposable-control-session-client.js';
import {
	OpenClawProcessSupervisorInvocationError,
	OpenClawProcessSupervisorReceiptError,
	type OpenClawProcessSupervisor,
} from '../controller/process-supervisor/openclaw-process-supervisor.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';

export const OPENCLAW_PROCESS_SUCCESSOR_PHASE_TIMEOUT_MS = 45_000;
export const OPENCLAW_PROCESS_SUCCESSOR_MAX_ATTEMPTS = 3;

export interface OpenClawProcessRecoveryAction {
	readonly signal: AbortSignal;
}

export interface OpenClawProcessSuccessorDeadlineTimer {
	cancel(): void;
	unref?(): void;
}

export interface OpenClawProcessEpochLossBarrier {
	readonly affectedLeaseIds: readonly string[];
	destroyAffectedLeases(): Promise<void>;
}

export interface OpenClawGatewayProcessEpochBinding {
	readonly controlSession: GatewayDisposableControlSessionClient;
	readonly material: GatewayControlSessionMaterial;
	readonly processSpec: GatewayProcessSpec;
}

export interface OpenClawGatewayProcessEpochOwner {
	getCurrentBinding(): OpenClawGatewayProcessEpochBinding;
	replaceCurrentProcess(options: {
		readonly action?: OpenClawProcessRecoveryAction;
		readonly expectedProcessEpoch: string;
		readonly selectSuccessorProcessEpoch: () => string | undefined;
	}): Promise<OpenClawGatewayProcessEpochBinding>;
}

type OpenClawProcessSuccessorAttemptResult =
	| {
			readonly binding: OpenClawGatewayProcessEpochBinding;
			readonly kind: 'published';
	  }
	| {
			readonly error: unknown;
			readonly kind: 'retryable-failure';
	  };

type OpenClawProcessSuccessorFailurePhase =
	| 'control-connect'
	| 'persist-binding'
	| 'prepare-process'
	| 'positive-observe'
	| 'service-health'
	| 'supervisor-start';

export function createOpenClawGatewayProcessEpochOwner(options: {
	readonly beginProcessEpochLoss: (loss: {
		readonly ambiguousAtMs: number;
		readonly gateway: GatewayEpochIdentity;
		readonly processEpoch: string;
	}) => OpenClawProcessEpochLossBarrier;
	readonly connectControlSession: (
		material: GatewayControlSessionMaterial,
		options: { readonly signal: AbortSignal },
	) => Promise<GatewayDisposableControlSessionClient>;
	readonly createActionId?: (kind: 'contain' | 'observe' | 'start') => string;
	readonly gateway: GatewayEpochIdentity;
	readonly initialBinding: OpenClawGatewayProcessEpochBinding;
	readonly now?: () => number;
	readonly persistBinding: (binding: OpenClawGatewayProcessEpochBinding) => Promise<void>;
	readonly prepareProcess: (material: GatewayControlSessionMaterial) => Promise<GatewayProcessSpec>;
	readonly rollbackPersistedBinding: (binding: OpenClawGatewayProcessEpochBinding) => Promise<void>;
	readonly scheduleSuccessorDeadline?: (
		callback: () => void,
		delayMs: number,
	) => OpenClawProcessSuccessorDeadlineTimer;
	readonly supervisor: OpenClawProcessSupervisor;
	readonly waitForServiceHealth: (
		processSpec: GatewayProcessSpec,
		options: { readonly signal: AbortSignal },
	) => Promise<void>;
}): OpenClawGatewayProcessEpochOwner {
	const createActionId = options.createActionId ?? ((kind) => `${kind}-${randomUUID()}`);
	const now = options.now ?? Date.now;
	const scheduleSuccessorDeadline =
		options.scheduleSuccessorDeadline ??
		((callback: () => void, delayMs: number): OpenClawProcessSuccessorDeadlineTimer => {
			const timeout = setTimeout(callback, delayMs);
			return {
				cancel: () => clearTimeout(timeout),
				unref: () => timeout.unref?.(),
			};
		});
	let currentBinding = options.initialBinding;
	let activeReplacement: Promise<OpenClawGatewayProcessEpochBinding> | undefined;

	const replaceCurrentProcess = async (replacement: {
		readonly action?: OpenClawProcessRecoveryAction;
		readonly expectedProcessEpoch: string;
		readonly selectSuccessorProcessEpoch: () => string | undefined;
	}): Promise<OpenClawGatewayProcessEpochBinding> => {
		if (currentBinding.material.processEpoch !== replacement.expectedProcessEpoch) {
			throw new Error(
				`OpenClaw process replacement expected '${replacement.expectedProcessEpoch}' but current is '${currentBinding.material.processEpoch}'.`,
			);
		}
		const lossBarrier = options.beginProcessEpochLoss({
			ambiguousAtMs: now(),
			gateway: options.gateway,
			processEpoch: replacement.expectedProcessEpoch,
		});
		const assertParentActionCurrent = (): void => {
			if (replacement.action?.signal.aborted === true) {
				throw replacement.action.signal.reason instanceof Error
					? replacement.action.signal.reason
					: new Error('OpenClaw process recovery action was aborted.');
			}
		};
		currentBinding.controlSession.close();
		await options.supervisor.contain({
			actionId: createActionId('contain'),
			expectedProcessEpoch: replacement.expectedProcessEpoch,
		});
		assertParentActionCurrent();
		await lossBarrier.destroyAffectedLeases();
		assertParentActionCurrent();
		const attemptSuccessor = async (
			selectedProcessEpoch: string,
		): Promise<OpenClawProcessSuccessorAttemptResult> => {
			let successorMayExist = false;
			let successorBindingPersisted = false;
			let successorFailurePhase: OpenClawProcessSuccessorFailurePhase = 'prepare-process';
			let successorDeadlineTimer: OpenClawProcessSuccessorDeadlineTimer | undefined;
			let successorDeadlineAbortController: AbortController | undefined;
			let removeParentAbortListener: (() => void) | undefined;
			let provisionalControlSession: GatewayDisposableControlSessionClient | undefined;
			try {
				const successorMaterial = deriveGatewayControlSessionMaterialForProcess(
					currentBinding.material,
					selectedProcessEpoch,
				);
				const successorDeadlineAtMs = now() + OPENCLAW_PROCESS_SUCCESSOR_PHASE_TIMEOUT_MS;
				successorDeadlineAbortController = new AbortController();
				const expireSuccessorDeadline = (): void => {
					successorDeadlineAbortController?.abort(
						new Error(
							`OpenClaw successor process '${selectedProcessEpoch}' exceeded its ${String(OPENCLAW_PROCESS_SUCCESSOR_PHASE_TIMEOUT_MS)}ms phase deadline.`,
						),
					);
				};
				if (replacement.action !== undefined) {
					const abortFromParent = (): void => {
						successorDeadlineAbortController?.abort(replacement.action?.signal.reason);
					};
					replacement.action.signal.addEventListener('abort', abortFromParent, { once: true });
					removeParentAbortListener = () =>
						replacement.action?.signal.removeEventListener('abort', abortFromParent);
					if (replacement.action.signal.aborted) {
						abortFromParent();
					}
				}
				successorDeadlineTimer = scheduleSuccessorDeadline(
					expireSuccessorDeadline,
					OPENCLAW_PROCESS_SUCCESSOR_PHASE_TIMEOUT_MS,
				);
				successorDeadlineTimer.unref?.();
				const assertSuccessorActionCurrent = (): void => {
					if (now() > successorDeadlineAtMs && !successorDeadlineAbortController?.signal.aborted) {
						expireSuccessorDeadline();
					}
					if (successorDeadlineAbortController?.signal.aborted) {
						throw successorDeadlineAbortController.signal.reason instanceof Error
							? successorDeadlineAbortController.signal.reason
							: new Error('OpenClaw successor process action was aborted.');
					}
				};
				assertSuccessorActionCurrent();
				const successorProcessSpec = await options.prepareProcess(successorMaterial);
				assertSuccessorActionCurrent();
				successorMayExist = true;
				successorFailurePhase = 'supervisor-start';
				await options.supervisor.start({
					actionId: createActionId('start'),
					expectedProcessEpoch: null,
					selectedProcessEpoch,
				});
				assertSuccessorActionCurrent();
				successorFailurePhase = 'positive-observe';
				const successorObservation = await options.supervisor.observe({
					actionId: createActionId('observe'),
					expectedProcessEpoch: selectedProcessEpoch,
				});
				if (
					successorObservation.kind !== 'observe' ||
					successorObservation.status !== 'completed' ||
					successorObservation.expectedProcessEpoch !== selectedProcessEpoch ||
					successorObservation.observedProcessEpoch !== selectedProcessEpoch ||
					!successorObservation.cgroup.populated
				) {
					throw new Error(
						`OpenClaw successor process '${selectedProcessEpoch}' was not positively observed in its exact cgroup.`,
					);
				}
				assertSuccessorActionCurrent();
				successorFailurePhase = 'service-health';
				await options.waitForServiceHealth(successorProcessSpec, {
					signal: successorDeadlineAbortController.signal,
				});
				assertSuccessorActionCurrent();
				successorFailurePhase = 'control-connect';
				provisionalControlSession = await options.connectControlSession(successorMaterial, {
					signal: successorDeadlineAbortController.signal,
				});
				assertSuccessorActionCurrent();
				const successorBinding = {
					controlSession: provisionalControlSession,
					material: successorMaterial,
					processSpec: successorProcessSpec,
				} satisfies OpenClawGatewayProcessEpochBinding;
				successorFailurePhase = 'persist-binding';
				await options.persistBinding(successorBinding);
				successorBindingPersisted = true;
				assertSuccessorActionCurrent();
				currentBinding = successorBinding;
				return { binding: successorBinding, kind: 'published' };
			} catch (replacementError) {
				const supervisorReceiptError =
					replacementError instanceof OpenClawProcessSupervisorReceiptError
						? replacementError
						: undefined;
				if (
					successorFailurePhase === 'supervisor-start' &&
					supervisorReceiptError?.receipt.status === 'refused' &&
					supervisorReceiptError.receipt.observedProcessEpoch !== selectedProcessEpoch
				) {
					successorMayExist = false;
				}
				const boundedFailurePhase =
					supervisorReceiptError !== undefined
						? `${successorFailurePhase}:${supervisorReceiptError.receipt.reason}`
						: replacementError instanceof OpenClawProcessSupervisorInvocationError
							? `${successorFailurePhase}:${replacementError.code}`
							: successorFailurePhase;
				const successorPhaseError = new Error(
					`OpenClaw successor process '${selectedProcessEpoch}' failed during phase '${boundedFailurePhase}'.`,
					{ cause: replacementError },
				);
				const cleanupErrors: unknown[] = [replacementError];
				let containmentFailed = false;
				let persistedBindingRollbackFailed = false;
				let provisionalSessionCloseFailed = false;
				if (successorBindingPersisted) {
					try {
						await options.rollbackPersistedBinding(currentBinding);
					} catch (rollbackError) {
						persistedBindingRollbackFailed = true;
						cleanupErrors.push(rollbackError);
					}
				}
				try {
					provisionalControlSession?.close();
				} catch (closeError) {
					provisionalSessionCloseFailed = true;
					cleanupErrors.push(closeError);
				}
				if (successorMayExist) {
					try {
						await options.supervisor.contain({
							actionId: createActionId('contain'),
							expectedProcessEpoch: selectedProcessEpoch,
						});
					} catch (containmentError) {
						containmentFailed = true;
						cleanupErrors.push(containmentError);
					}
				}
				if (cleanupErrors.length > 1) {
					const aggregateError = new AggregateError(
						cleanupErrors,
						containmentFailed
							? `OpenClaw successor process '${selectedProcessEpoch}' failed during phase '${boundedFailurePhase}' and containment was not proven.`
							: persistedBindingRollbackFailed
								? `OpenClaw successor process '${selectedProcessEpoch}' failed and its previous durable binding was not restored.`
								: provisionalSessionCloseFailed
									? `OpenClaw successor process '${selectedProcessEpoch}' failed and its provisional control session was not closed.`
									: `OpenClaw successor process '${selectedProcessEpoch}' cleanup failed.`,
					);
					aggregateError.cause = replacementError;
					throw aggregateError;
				}
				return { error: successorPhaseError, kind: 'retryable-failure' };
			} finally {
				successorDeadlineTimer?.cancel();
				removeParentAbortListener?.();
			}
		};

		const selectAndAttemptSuccessor = async (
			attemptIndex: number,
			lastSuccessorFailure?: { readonly error: unknown },
		): Promise<OpenClawGatewayProcessEpochBinding> => {
			assertParentActionCurrent();
			if (attemptIndex >= OPENCLAW_PROCESS_SUCCESSOR_MAX_ATTEMPTS) {
				if (lastSuccessorFailure !== undefined) {
					throw lastSuccessorFailure.error;
				}
				throw new Error(
					`OpenClaw process '${replacement.expectedProcessEpoch}' recovery exhausted its successor attempt budget.`,
				);
			}
			const selectedProcessEpoch = replacement.selectSuccessorProcessEpoch();
			if (selectedProcessEpoch === undefined) {
				if (lastSuccessorFailure !== undefined) {
					throw lastSuccessorFailure.error;
				}
				throw new Error(
					`OpenClaw process '${replacement.expectedProcessEpoch}' recovery did not select a successor process epoch.`,
				);
			}
			const successorAttempt = await attemptSuccessor(selectedProcessEpoch);
			if (successorAttempt.kind === 'published') {
				return successorAttempt.binding;
			}
			return await selectAndAttemptSuccessor(attemptIndex + 1, {
				error: successorAttempt.error,
			});
		};
		return await selectAndAttemptSuccessor(0);
	};

	return {
		getCurrentBinding(): OpenClawGatewayProcessEpochBinding {
			return currentBinding;
		},
		replaceCurrentProcess(replacement): Promise<OpenClawGatewayProcessEpochBinding> {
			if (activeReplacement !== undefined) {
				return activeReplacement;
			}
			const replacementFlight = replaceCurrentProcess(replacement).finally(() => {
				if (activeReplacement === replacementFlight) {
					activeReplacement = undefined;
				}
			});
			activeReplacement = replacementFlight;
			return replacementFlight;
		},
	};
}
