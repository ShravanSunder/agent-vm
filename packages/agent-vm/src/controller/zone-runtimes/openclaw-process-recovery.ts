import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';

export const OPENCLAW_PROCESS_RECOVERY_ATTEMPT_WINDOW_MS = 5 * 60_000;
export const OPENCLAW_PROCESS_RECOVERY_COOLDOWN_MS = 5 * 60_000;
export const OPENCLAW_PROCESS_RECOVERY_MAX_ATTEMPTS = 3;
export const OPENCLAW_PROCESS_RECOVERY_STABILITY_HEARTBEATS = 6;
export const OPENCLAW_PROCESS_RECOVERY_STABILITY_MS = 60_000;
export const OPENCLAW_PROCESS_RECOVERY_STABILITY_OBSERVATIONS = 3;
export const OPENCLAW_PROCESS_RECOVERY_SUCCESS_HISTORY_MS = 60 * 60_000;
export const OPENCLAW_PROCESS_RECOVERY_SUCCESS_LIMIT = 3;
export const OPENCLAW_GATEWAY_ESCALATION_MAX_ATTEMPTS = 3;
export const OPENCLAW_GATEWAY_ESCALATION_RETRY_DELAY_MS = 5_000;

export interface OpenClawProcessRecoveryBinding {
	readonly gateway: GatewayEpochIdentity;
	readonly processEpoch: string;
}

export interface OpenClawProcessRecoveryTrigger extends OpenClawProcessRecoveryBinding {
	readonly kind: 'control-reconnect-exhausted' | 'process-observation-failed';
}

export interface OpenClawProcessRecoveryCoordinator {
	cancelPendingRecovery(): void;
	recordControlHeartbeat(binding: OpenClawProcessRecoveryBinding): void;
	recordPopulatedProcessObservation(binding: OpenClawProcessRecoveryBinding): void;
	requestRecovery(trigger: OpenClawProcessRecoveryTrigger): Promise<void>;
}

export interface OpenClawProcessRecoveryAttemptBudget {
	selectSuccessorAttempt(): boolean;
}

export interface OpenClawGatewayEscalationRetryTimer {
	cancel(): void;
	unref?(): void;
}

interface StabilizingOpenClawProcessRecovery {
	readonly binding: OpenClawProcessRecoveryBinding;
	controlHeartbeatCount: number;
	populatedProcessObservationCount: number;
	readonly startedAtMs: number;
}

export function createOpenClawProcessRecoveryCoordinator(options: {
	readonly escalateGatewayRecovery: (
		error: unknown,
		binding: OpenClawProcessRecoveryBinding,
	) => void | Promise<void>;
	readonly getCurrentBinding: () => OpenClawProcessRecoveryBinding | undefined;
	readonly nowMs?: () => number;
	readonly recoverCurrentProcess: (
		trigger: OpenClawProcessRecoveryTrigger,
		attemptBudget: OpenClawProcessRecoveryAttemptBudget,
	) => Promise<void>;
	readonly scheduleGatewayEscalationRetry?: (
		callback: () => void,
		delayMs: number,
	) => OpenClawGatewayEscalationRetryTimer;
}): OpenClawProcessRecoveryCoordinator {
	const nowMs = options.nowMs ?? Date.now;
	const scheduleGatewayEscalationRetry =
		options.scheduleGatewayEscalationRetry ??
		((callback: () => void, delayMs: number): OpenClawGatewayEscalationRetryTimer => {
			const timeout = setTimeout(callback, delayMs);
			return { cancel: () => clearTimeout(timeout), unref: () => timeout.unref?.() };
		});
	let activeRecovery: Promise<void> | undefined;
	let budgetGateway: GatewayEpochIdentity | undefined;
	let cooldownUntilMs: number | undefined;
	let escalatedBinding: OpenClawProcessRecoveryBinding | undefined;
	let escalationAttemptCount = 0;
	let escalationCompleted = false;
	let requiredEscalationError: unknown;
	let recoveryCancellationGeneration = 0;
	let escalationRetryTimer: OpenClawGatewayEscalationRetryTimer | undefined;
	let stabilizingRecovery: StabilizingOpenClawProcessRecovery | undefined;
	let stableRecoveryTimesMs: number[] = [];
	let successorAttemptTimesMs: number[] = [];

	const resetBudgetForGateway = (gateway: GatewayEpochIdentity): void => {
		if (budgetGateway !== undefined && gatewayIdentitiesEqual(budgetGateway, gateway)) {
			return;
		}
		budgetGateway = gateway;
		escalationRetryTimer?.cancel();
		escalationRetryTimer = undefined;
		escalationAttemptCount = 0;
		cooldownUntilMs = undefined;
		stabilizingRecovery = undefined;
		stableRecoveryTimesMs = [];
		successorAttemptTimesMs = [];
	};
	const pruneRecoveryHistory = (observedAtMs: number): void => {
		successorAttemptTimesMs = successorAttemptTimesMs.filter(
			(attemptAtMs) => observedAtMs - attemptAtMs < OPENCLAW_PROCESS_RECOVERY_ATTEMPT_WINDOW_MS,
		);
		stableRecoveryTimesMs = stableRecoveryTimesMs.filter(
			(successAtMs) => observedAtMs - successAtMs < OPENCLAW_PROCESS_RECOVERY_SUCCESS_HISTORY_MS,
		);
	};
	const bindingIsCurrent = (binding: OpenClawProcessRecoveryBinding): boolean => {
		const currentBinding = options.getCurrentBinding();
		return (
			currentBinding !== undefined &&
			gatewayIdentitiesEqual(currentBinding.gateway, binding.gateway) &&
			currentBinding.processEpoch === binding.processEpoch
		);
	};
	const invokeGatewayEscalation = (
		error: unknown,
		binding: OpenClawProcessRecoveryBinding,
	): Promise<void> => {
		try {
			return Promise.resolve(options.escalateGatewayRecovery(error, binding));
		} catch (invocationError) {
			return Promise.reject(invocationError);
		}
	};
	const startGatewayEscalation = (
		binding: OpenClawProcessRecoveryBinding,
		escalationReason: unknown,
	): Promise<void> => {
		const escalationGeneration = recoveryCancellationGeneration;
		escalationRetryTimer?.cancel();
		escalationRetryTimer = undefined;
		escalatedBinding = { gateway: binding.gateway, processEpoch: binding.processEpoch };
		escalationCompleted = false;
		requiredEscalationError = escalationReason;
		escalationAttemptCount += 1;
		const escalationFlight = invokeGatewayEscalation(escalationReason, binding)
			.then(() => {
				escalationCompleted = true;
			})
			.catch((error: unknown) => {
				if (
					escalationGeneration === recoveryCancellationGeneration &&
					escalationAttemptCount < OPENCLAW_GATEWAY_ESCALATION_MAX_ATTEMPTS
				) {
					escalationRetryTimer = scheduleGatewayEscalationRetry(() => {
						escalationRetryTimer = undefined;
						if (escalationGeneration !== recoveryCancellationGeneration) {
							return;
						}
						const currentBinding = options.getCurrentBinding();
						if (
							currentBinding !== undefined &&
							(!gatewayIdentitiesEqual(currentBinding.gateway, binding.gateway) ||
								currentBinding.processEpoch !== binding.processEpoch)
						) {
							escalatedBinding = undefined;
							escalationAttemptCount = 0;
							requiredEscalationError = undefined;
							return;
						}
						void startGatewayEscalation(binding, escalationReason).catch(() => undefined);
					}, OPENCLAW_GATEWAY_ESCALATION_RETRY_DELAY_MS);
					escalationRetryTimer.unref?.();
				}
				throw error;
			})
			.finally(() => {
				if (activeRecovery === escalationFlight) {
					activeRecovery = undefined;
				}
			});
		activeRecovery = escalationFlight;
		return escalationFlight;
	};
	const recordStabilityEvidence = (
		binding: OpenClawProcessRecoveryBinding,
		evidence: 'control-heartbeat' | 'populated-process-observation',
	): void => {
		const stabilizing = stabilizingRecovery;
		if (
			stabilizing === undefined ||
			!bindingIsCurrent(binding) ||
			!gatewayIdentitiesEqual(stabilizing.binding.gateway, binding.gateway) ||
			stabilizing.binding.processEpoch !== binding.processEpoch
		) {
			return;
		}
		if (evidence === 'control-heartbeat') {
			stabilizing.controlHeartbeatCount += 1;
		} else {
			stabilizing.populatedProcessObservationCount += 1;
		}
		const observedAtMs = nowMs();
		if (
			stabilizing.controlHeartbeatCount < OPENCLAW_PROCESS_RECOVERY_STABILITY_HEARTBEATS ||
			stabilizing.populatedProcessObservationCount <
				OPENCLAW_PROCESS_RECOVERY_STABILITY_OBSERVATIONS ||
			observedAtMs - stabilizing.startedAtMs < OPENCLAW_PROCESS_RECOVERY_STABILITY_MS
		) {
			return;
		}
		stableRecoveryTimesMs.push(observedAtMs);
		pruneRecoveryHistory(observedAtMs);
		cooldownUntilMs = observedAtMs + OPENCLAW_PROCESS_RECOVERY_COOLDOWN_MS;
		stabilizingRecovery = undefined;
	};

	return {
		cancelPendingRecovery(): void {
			recoveryCancellationGeneration += 1;
			escalationRetryTimer?.cancel();
			escalationRetryTimer = undefined;
			escalatedBinding = undefined;
			escalationAttemptCount = 0;
			escalationCompleted = false;
			requiredEscalationError = undefined;
			stabilizingRecovery = undefined;
		},
		recordControlHeartbeat(binding): void {
			recordStabilityEvidence(binding, 'control-heartbeat');
		},
		recordPopulatedProcessObservation(binding): void {
			recordStabilityEvidence(binding, 'populated-process-observation');
		},
		requestRecovery(trigger): Promise<void> {
			const currentBinding = options.getCurrentBinding();
			if (
				currentBinding === undefined ||
				!gatewayIdentitiesEqual(currentBinding.gateway, trigger.gateway) ||
				currentBinding.processEpoch !== trigger.processEpoch
			) {
				return Promise.resolve();
			}
			resetBudgetForGateway(currentBinding.gateway);
			if (
				escalatedBinding !== undefined &&
				(!gatewayIdentitiesEqual(escalatedBinding.gateway, currentBinding.gateway) ||
					escalatedBinding.processEpoch !== currentBinding.processEpoch)
			) {
				escalatedBinding = undefined;
				escalationRetryTimer?.cancel();
				escalationRetryTimer = undefined;
				escalationAttemptCount = 0;
				escalationCompleted = false;
				requiredEscalationError = undefined;
			}
			if (activeRecovery !== undefined) {
				return activeRecovery;
			}
			if (
				trigger.kind === 'control-reconnect-exhausted' &&
				stabilizingRecovery !== undefined &&
				gatewayIdentitiesEqual(stabilizingRecovery.binding.gateway, currentBinding.gateway) &&
				stabilizingRecovery.binding.processEpoch === currentBinding.processEpoch
			) {
				if (nowMs() - stabilizingRecovery.startedAtMs < OPENCLAW_PROCESS_RECOVERY_STABILITY_MS) {
					return Promise.resolve();
				}
				stabilizingRecovery = undefined;
				return startGatewayEscalation(
					currentBinding,
					new Error(
						`OpenClaw process '${currentBinding.processEpoch}' did not establish stable control and process health.`,
					),
				);
			}
			if (
				escalatedBinding !== undefined &&
				gatewayIdentitiesEqual(escalatedBinding.gateway, trigger.gateway) &&
				escalatedBinding.processEpoch === trigger.processEpoch
			) {
				if (
					escalationCompleted ||
					escalationRetryTimer !== undefined ||
					escalationAttemptCount >= OPENCLAW_GATEWAY_ESCALATION_MAX_ATTEMPTS
				) {
					return Promise.resolve();
				}
				return startGatewayEscalation(trigger, requiredEscalationError);
			}
			const observedAtMs = nowMs();
			pruneRecoveryHistory(observedAtMs);
			const escalationReason =
				cooldownUntilMs !== undefined && observedAtMs < cooldownUntilMs
					? new Error(
							`OpenClaw process '${trigger.processEpoch}' failed during the process recovery cooldown.`,
						)
					: stableRecoveryTimesMs.length > OPENCLAW_PROCESS_RECOVERY_SUCCESS_LIMIT
						? new Error(
								`OpenClaw Gateway '${trigger.gateway.gatewayEpochId}' exceeded its hourly same-G process recovery budget.`,
							)
						: successorAttemptTimesMs.length >= OPENCLAW_PROCESS_RECOVERY_MAX_ATTEMPTS
							? new Error(
									`OpenClaw Gateway '${trigger.gateway.gatewayEpochId}' exhausted its rolling process successor attempt budget.`,
								)
							: undefined;
			if (escalationReason !== undefined) {
				return startGatewayEscalation(trigger, escalationReason);
			}
			stabilizingRecovery = undefined;
			const attemptBudget = {
				selectSuccessorAttempt(): boolean {
					const attemptAtMs = nowMs();
					pruneRecoveryHistory(attemptAtMs);
					if (successorAttemptTimesMs.length >= OPENCLAW_PROCESS_RECOVERY_MAX_ATTEMPTS) {
						return false;
					}
					successorAttemptTimesMs.push(attemptAtMs);
					return true;
				},
			} satisfies OpenClawProcessRecoveryAttemptBudget;
			let processRecovery: Promise<void>;
			try {
				processRecovery = options.recoverCurrentProcess(trigger, attemptBudget);
			} catch (error) {
				processRecovery = Promise.reject(error);
			}
			const recoveryGeneration = recoveryCancellationGeneration;
			const recoveryFlight = processRecovery
				.then(() => {
					if (recoveryGeneration !== recoveryCancellationGeneration) {
						return;
					}
					const successorBinding = options.getCurrentBinding();
					if (
						successorBinding !== undefined &&
						gatewayIdentitiesEqual(successorBinding.gateway, trigger.gateway) &&
						successorBinding.processEpoch !== trigger.processEpoch
					) {
						stabilizingRecovery = {
							binding: successorBinding,
							controlHeartbeatCount: 0,
							populatedProcessObservationCount: 0,
							startedAtMs: nowMs(),
						};
					}
				})
				.catch((error: unknown) =>
					recoveryGeneration === recoveryCancellationGeneration
						? startGatewayEscalation(trigger, error)
						: undefined,
				)
				.finally(() => {
					if (activeRecovery === recoveryFlight) {
						activeRecovery = undefined;
					}
				});
			activeRecovery = recoveryFlight;
			return recoveryFlight;
		},
	};
}
