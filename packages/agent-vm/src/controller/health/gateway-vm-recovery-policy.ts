import type { GatewayRecoveryHealthReason } from '@agent-vm/gateway-interface';

export type GatewayVmRecoveryObservationResult =
	| 'failed'
	| 'ok'
	| 'stale'
	| 'timeout'
	| 'unobserved';

export type GatewayVmRecoveryReason = GatewayRecoveryHealthReason;
export type GatewayVmRecoveryBudgetClass = 'gateway-vm-cold-start' | 'gateway-vm-restart';
export type GatewayVmRecoveryCorroborationState = 'connected' | 'recovery-due' | 'within-grace';

export const GATEWAY_VM_RECOVERY_STABILITY_OBSERVATIONS = 3;

export interface GatewayVmAutoRecoveryPolicy {
	readonly channelProviderHealth?: GatewayVmChannelProviderRecoveryPolicy | undefined;
	readonly consecutiveFailureThreshold: number;
	readonly cooldownMs: number;
	readonly enabled: boolean;
	readonly failedRecoveryResetMs: number;
	readonly maxConsecutiveFailedRecoveries: number;
	readonly restartTimeoutMs: number;
}

export interface GatewayVmChannelProviderRecoveryPolicy {
	readonly consecutiveFailureThreshold: number;
	readonly enabled: boolean;
	readonly restartGatewayOnRecoverable: boolean;
	readonly restartGatewayOnUnrecoverable: boolean;
	readonly transitioningTimeoutMs: number;
}

export const defaultGatewayVmChannelProviderRecoveryPolicy = {
	consecutiveFailureThreshold: 3,
	enabled: true,
	restartGatewayOnRecoverable: false,
	restartGatewayOnUnrecoverable: false,
	transitioningTimeoutMs: 120_000,
} satisfies GatewayVmChannelProviderRecoveryPolicy;

export interface CreateGatewayVmRecoveryTrackerOptions {
	readonly policy: GatewayVmAutoRecoveryPolicy;
}

export interface GatewayVmRecoveryObservation {
	readonly channelProviderHealth?:
		| 'healthy'
		| 'transitioning'
		| 'unhealthy-recoverable'
		| 'unhealthy-unrecoverable'
		| undefined;
	readonly channelProviderId?: string | undefined;
	readonly controlSessionDeathGrace?: GatewayVmRecoveryCorroborationState | undefined;
	readonly observedAtMs: number;
	readonly recoveryBudgetClass?: GatewayVmRecoveryBudgetClass | undefined;
	readonly result: GatewayVmRecoveryObservationResult;
	readonly sourceKey?: GatewayVmRecoverySourceKey | undefined;
	readonly zoneId: string;
}

export interface GatewayVmRecoverySourceKey {
	readonly bootId: string;
	readonly domain: 'gateway_control';
	readonly gatewayVmId: string;
	readonly generationId: string;
	readonly zoneId: string;
}

export interface GatewayVmRecoveryLifecycleEvent {
	readonly observedAtMs: number;
	readonly recoveryBudgetClass?: GatewayVmRecoveryBudgetClass | undefined;
	readonly result?: 'failed' | 'ok' | undefined;
	readonly zoneId: string;
}

export type GatewayVmRecoveryDecision =
	| {
			readonly consecutiveFailures: number;
			readonly kind: 'none';
			readonly reason?:
				| 'cooldown'
				| 'disabled'
				| 'in-flight'
				| 'missing-source-key'
				| 'needs-corroboration'
				| 'stabilizing'
				| 'unobserved'
				| 'within-grace'
				| undefined;
	  }
	| {
			readonly consecutiveFailures: number;
			readonly kind: 'restart';
			readonly reason: GatewayVmRecoveryReason;
			readonly zoneId: string;
	  }
	| {
			readonly consecutiveFailedRecoveries: number;
			readonly consecutiveFailures: number;
			readonly kind: 'suspended';
			readonly outwardEscalationRequired: boolean;
			readonly reason: 'max-failed-recoveries';
			readonly zoneId: string;
	  };

export interface GatewayVmRecoveryTracker {
	readonly markRecoveryFinished: (event: GatewayVmRecoveryLifecycleEvent) => void;
	readonly markRecoveryStarted: (event: GatewayVmRecoveryLifecycleEvent) => void;
	readonly recordAgentChannelProviderObservation: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
	readonly recordGatewayControlSessionObservation: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
	readonly recordGatewayServiceProbe: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
	readonly recordGatewaySourceChange: (event: {
		readonly sourceKey: GatewayVmRecoverySourceKey;
		readonly zoneId: string;
	}) => void;
}

interface GatewayVmRecoveryTrackerState {
	agentChannelProviderConsecutiveFailuresById: Map<string, number>;
	gatewayControlSessionConsecutiveFailures: number;
	gatewayControlSessionRecoveryDueAtMs: number | undefined;
	gatewayControlSessionRecoveryDue: boolean;
	gatewayRecoverySourceKey: string | undefined;
	gatewayServiceConsecutiveFailures: number;
	gatewayServiceLastFailureAtMs: number | undefined;
	recoveryBudgets: Record<GatewayVmRecoveryBudgetClass, GatewayVmRecoveryBudgetState>;
	recoveryInFlight: boolean;
	stabilizingRecovery: StabilizingGatewayVmRecovery | undefined;
}

interface GatewayVmRecoveryBudgetState {
	consecutiveFailedRecoveries: number;
	lastRecoveryAttemptAtMs: number | undefined;
	operatorEscalationEmitted: boolean;
}

interface StabilizingGatewayVmRecovery {
	boundSourceKey: string | undefined;
	controlSessionHealthyObservations: number;
	recoveryBudgetClass: GatewayVmRecoveryBudgetClass;
	serviceHealthyObservations: number;
	startedAtMs: number;
}

function createInitialGatewayVmRecoveryBudgetState(): GatewayVmRecoveryBudgetState {
	return {
		consecutiveFailedRecoveries: 0,
		lastRecoveryAttemptAtMs: undefined,
		operatorEscalationEmitted: false,
	};
}

const createInitialGatewayVmRecoveryTrackerState = (): GatewayVmRecoveryTrackerState => ({
	agentChannelProviderConsecutiveFailuresById: new Map(),
	gatewayControlSessionConsecutiveFailures: 0,
	gatewayControlSessionRecoveryDueAtMs: undefined,
	gatewayControlSessionRecoveryDue: false,
	gatewayRecoverySourceKey: undefined,
	gatewayServiceConsecutiveFailures: 0,
	gatewayServiceLastFailureAtMs: undefined,
	recoveryBudgets: {
		'gateway-vm-cold-start': createInitialGatewayVmRecoveryBudgetState(),
		'gateway-vm-restart': createInitialGatewayVmRecoveryBudgetState(),
	},
	recoveryInFlight: false,
	stabilizingRecovery: undefined,
});

function recoveryBudgetClassForEvent(
	event: Pick<GatewayVmRecoveryLifecycleEvent, 'recoveryBudgetClass'>,
): GatewayVmRecoveryBudgetClass {
	return event.recoveryBudgetClass ?? 'gateway-vm-restart';
}

function isHealthyObservation(result: GatewayVmRecoveryObservationResult): boolean {
	return result === 'ok';
}

function isDegradedObservation(result: GatewayVmRecoveryObservationResult): boolean {
	return result === 'failed' || result === 'stale' || result === 'timeout';
}

function isWithinCooldown(
	budgetState: GatewayVmRecoveryBudgetState,
	policy: GatewayVmAutoRecoveryPolicy,
	observedAtMs: number,
): boolean {
	return (
		budgetState.lastRecoveryAttemptAtMs !== undefined &&
		observedAtMs - budgetState.lastRecoveryAttemptAtMs < policy.cooldownMs
	);
}

function hasActiveRecoverySuspension(
	budgetState: GatewayVmRecoveryBudgetState,
	policy: GatewayVmAutoRecoveryPolicy,
	observedAtMs: number,
): boolean {
	return (
		budgetState.consecutiveFailedRecoveries >= policy.maxConsecutiveFailedRecoveries &&
		budgetState.lastRecoveryAttemptAtMs !== undefined &&
		observedAtMs - budgetState.lastRecoveryAttemptAtMs < policy.failedRecoveryResetMs
	);
}

function resetFailedRecoveriesIfSuspensionExpired(
	budgetState: GatewayVmRecoveryBudgetState,
	policy: GatewayVmAutoRecoveryPolicy,
	observedAtMs: number,
): void {
	if (
		budgetState.consecutiveFailedRecoveries >= policy.maxConsecutiveFailedRecoveries &&
		budgetState.lastRecoveryAttemptAtMs !== undefined &&
		observedAtMs - budgetState.lastRecoveryAttemptAtMs >= policy.failedRecoveryResetMs
	) {
		budgetState.consecutiveFailedRecoveries = 0;
		budgetState.operatorEscalationEmitted = false;
	}
}

function channelProviderCounterKey(observation: GatewayVmRecoveryObservation): string {
	return observation.channelProviderId ?? '(unknown-channel-provider)';
}

function gatewayRecoverySourceKey(key: GatewayVmRecoverySourceKey): string {
	return [key.domain, key.zoneId, key.gatewayVmId, key.bootId, key.generationId].join('\0');
}

function recordGatewayRecoverySource(
	state: GatewayVmRecoveryTrackerState,
	sourceKey: GatewayVmRecoverySourceKey,
): void {
	const serializedSourceKey = gatewayRecoverySourceKey(sourceKey);
	if (
		state.gatewayRecoverySourceKey !== undefined &&
		state.gatewayRecoverySourceKey !== serializedSourceKey
	) {
		state.gatewayControlSessionConsecutiveFailures = 0;
		state.gatewayControlSessionRecoveryDue = false;
		state.gatewayControlSessionRecoveryDueAtMs = undefined;
	}
	state.gatewayRecoverySourceKey = serializedSourceKey;
	const stabilizingRecovery = state.stabilizingRecovery;
	if (stabilizingRecovery !== undefined && stabilizingRecovery.boundSourceKey === undefined) {
		stabilizingRecovery.boundSourceKey = serializedSourceKey;
	}
}

function maybeFinishGatewayRecoveryStabilization(props: {
	readonly observedAtMs: number;
	readonly policy: GatewayVmAutoRecoveryPolicy;
	readonly state: GatewayVmRecoveryTrackerState;
}): void {
	const stabilizingRecovery = props.state.stabilizingRecovery;
	if (
		stabilizingRecovery === undefined ||
		stabilizingRecovery.boundSourceKey === undefined ||
		stabilizingRecovery.controlSessionHealthyObservations <
			GATEWAY_VM_RECOVERY_STABILITY_OBSERVATIONS ||
		stabilizingRecovery.serviceHealthyObservations < GATEWAY_VM_RECOVERY_STABILITY_OBSERVATIONS ||
		props.observedAtMs - stabilizingRecovery.startedAtMs < props.policy.restartTimeoutMs
	) {
		return;
	}
	const budgetState = props.state.recoveryBudgets[stabilizingRecovery.recoveryBudgetClass];
	budgetState.consecutiveFailedRecoveries = 0;
	budgetState.lastRecoveryAttemptAtMs = props.observedAtMs;
	budgetState.operatorEscalationEmitted = false;
	props.state.stabilizingRecovery = undefined;
}

function gatewayRecoveryCorroborationWindowMs(policy: GatewayVmAutoRecoveryPolicy): number {
	return Math.max(policy.restartTimeoutMs, 1);
}

function observationIsFreshInWindow(props: {
	readonly observedAtMs: number;
	readonly previousObservedAtMs: number | undefined;
	readonly windowMs: number;
}): boolean {
	return (
		props.previousObservedAtMs !== undefined &&
		props.observedAtMs >= props.previousObservedAtMs &&
		props.observedAtMs - props.previousObservedAtMs <= props.windowMs
	);
}

function decideRecovery(props: {
	readonly consecutiveFailures: number;
	readonly observedAtMs: number;
	readonly policy: GatewayVmAutoRecoveryPolicy;
	readonly reason: GatewayVmRecoveryReason;
	readonly recoveryBudgetClass: GatewayVmRecoveryBudgetClass;
	readonly state: GatewayVmRecoveryTrackerState;
	readonly zoneId: string;
}): GatewayVmRecoveryDecision {
	if (!props.policy.enabled) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none', reason: 'disabled' };
	}
	if (props.state.recoveryInFlight) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none', reason: 'in-flight' };
	}
	if (props.state.stabilizingRecovery !== undefined) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none', reason: 'stabilizing' };
	}
	if (props.consecutiveFailures < props.policy.consecutiveFailureThreshold) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none' };
	}
	const budgetState = props.state.recoveryBudgets[props.recoveryBudgetClass];
	if (isWithinCooldown(budgetState, props.policy, props.observedAtMs)) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none', reason: 'cooldown' };
	}
	resetFailedRecoveriesIfSuspensionExpired(budgetState, props.policy, props.observedAtMs);
	if (hasActiveRecoverySuspension(budgetState, props.policy, props.observedAtMs)) {
		const outwardEscalationRequired = !budgetState.operatorEscalationEmitted;
		budgetState.operatorEscalationEmitted = true;
		return {
			consecutiveFailedRecoveries: budgetState.consecutiveFailedRecoveries,
			consecutiveFailures: props.consecutiveFailures,
			kind: 'suspended',
			outwardEscalationRequired,
			reason: 'max-failed-recoveries',
			zoneId: props.zoneId,
		};
	}
	return {
		consecutiveFailures: props.consecutiveFailures,
		kind: 'restart',
		reason: props.reason,
		zoneId: props.zoneId,
	};
}

function decideCorroboratedGatewayRecovery(props: {
	readonly observedAtMs: number;
	readonly policy: GatewayVmAutoRecoveryPolicy;
	readonly recoveryBudgetClass: GatewayVmRecoveryBudgetClass;
	readonly state: GatewayVmRecoveryTrackerState;
	readonly zoneId: string;
}): GatewayVmRecoveryDecision {
	const consecutiveFailures = Math.max(
		props.state.gatewayControlSessionConsecutiveFailures,
		props.state.gatewayServiceConsecutiveFailures,
	);
	if (!props.policy.enabled) {
		return { consecutiveFailures, kind: 'none', reason: 'disabled' };
	}
	if (props.recoveryBudgetClass === 'gateway-vm-cold-start') {
		if (props.state.gatewayServiceConsecutiveFailures < props.policy.consecutiveFailureThreshold) {
			return {
				consecutiveFailures: props.state.gatewayServiceConsecutiveFailures,
				kind: 'none',
				reason: 'needs-corroboration',
			};
		}
		return decideRecovery({
			consecutiveFailures: props.state.gatewayServiceConsecutiveFailures,
			observedAtMs: props.observedAtMs,
			policy: props.policy,
			reason: 'gateway-service-unhealthy',
			recoveryBudgetClass: props.recoveryBudgetClass,
			state: props.state,
			zoneId: props.zoneId,
		});
	}
	if (props.state.gatewayRecoverySourceKey === undefined) {
		return {
			consecutiveFailures,
			kind: 'none',
			reason: 'missing-source-key',
		};
	}
	const corroborationWindowMs = gatewayRecoveryCorroborationWindowMs(props.policy);
	const controlSessionRecoveryDueIsFresh =
		props.state.gatewayControlSessionRecoveryDue &&
		observationIsFreshInWindow({
			observedAtMs: props.observedAtMs,
			previousObservedAtMs: props.state.gatewayControlSessionRecoveryDueAtMs,
			windowMs: corroborationWindowMs,
		});
	if (!controlSessionRecoveryDueIsFresh) {
		return {
			consecutiveFailures,
			kind: 'none',
			reason: 'needs-corroboration',
		};
	}
	if (
		props.state.gatewayServiceConsecutiveFailures < props.policy.consecutiveFailureThreshold ||
		!observationIsFreshInWindow({
			observedAtMs: props.observedAtMs,
			previousObservedAtMs: props.state.gatewayServiceLastFailureAtMs,
			windowMs: corroborationWindowMs,
		})
	) {
		return {
			consecutiveFailures,
			kind: 'none',
			reason: 'needs-corroboration',
		};
	}
	return decideRecovery({
		consecutiveFailures,
		observedAtMs: props.observedAtMs,
		policy: props.policy,
		reason: 'gateway-control-session-unhealthy',
		recoveryBudgetClass: props.recoveryBudgetClass,
		state: props.state,
		zoneId: props.zoneId,
	});
}

export function createGatewayVmRecoveryTracker(
	options: CreateGatewayVmRecoveryTrackerOptions,
): GatewayVmRecoveryTracker {
	const stateByZoneId = new Map<string, GatewayVmRecoveryTrackerState>();

	const getStateForZone = (zoneId: string): GatewayVmRecoveryTrackerState => {
		const existingState = stateByZoneId.get(zoneId);
		if (existingState) {
			return existingState;
		}
		const state = createInitialGatewayVmRecoveryTrackerState();
		stateByZoneId.set(zoneId, state);
		return state;
	};

	return {
		markRecoveryFinished(event): void {
			const state = getStateForZone(event.zoneId);
			state.recoveryInFlight = false;
			if (event.result === 'ok') {
				state.stabilizingRecovery = {
					boundSourceKey: undefined,
					controlSessionHealthyObservations: 0,
					recoveryBudgetClass: recoveryBudgetClassForEvent(event),
					serviceHealthyObservations: 0,
					startedAtMs: event.observedAtMs,
				};
				return;
			}
			if (event.result === 'failed') {
				const budgetState = state.recoveryBudgets[recoveryBudgetClassForEvent(event)];
				budgetState.consecutiveFailedRecoveries += 1;
				budgetState.lastRecoveryAttemptAtMs = event.observedAtMs;
			}
		},
		markRecoveryStarted(event): void {
			const state = getStateForZone(event.zoneId);
			state.recoveryInFlight = true;
		},
		recordGatewaySourceChange(event): void {
			recordGatewayRecoverySource(getStateForZone(event.zoneId), event.sourceKey);
		},
		recordAgentChannelProviderObservation(observation): GatewayVmRecoveryDecision {
			const channelProviderPolicy =
				options.policy.channelProviderHealth ?? defaultGatewayVmChannelProviderRecoveryPolicy;
			const state = getStateForZone(observation.zoneId);
			const counterKey = channelProviderCounterKey(observation);
			const currentConsecutiveFailures =
				state.agentChannelProviderConsecutiveFailuresById.get(counterKey) ?? 0;
			if (observation.result === 'unobserved') {
				return {
					consecutiveFailures: currentConsecutiveFailures,
					kind: 'none',
					reason: 'unobserved',
				};
			}
			if (isHealthyObservation(observation.result)) {
				state.agentChannelProviderConsecutiveFailuresById.set(counterKey, 0);
				return { consecutiveFailures: 0, kind: 'none' };
			}
			let consecutiveFailures = currentConsecutiveFailures;
			if (isDegradedObservation(observation.result)) {
				consecutiveFailures += 1;
				state.agentChannelProviderConsecutiveFailuresById.set(counterKey, consecutiveFailures);
			}
			const restartGatewayForObservation =
				observation.channelProviderHealth === 'unhealthy-unrecoverable'
					? channelProviderPolicy.restartGatewayOnUnrecoverable
					: channelProviderPolicy.restartGatewayOnRecoverable;
			if (!restartGatewayForObservation) {
				return {
					consecutiveFailures,
					kind: 'none',
					reason: 'disabled',
				};
			}
			return decideRecovery({
				consecutiveFailures,
				observedAtMs: observation.observedAtMs,
				policy: {
					...options.policy,
					consecutiveFailureThreshold: channelProviderPolicy.consecutiveFailureThreshold,
					enabled: options.policy.enabled && channelProviderPolicy.enabled,
				},
				reason: 'agent-channel-provider-unhealthy',
				recoveryBudgetClass: observation.recoveryBudgetClass ?? 'gateway-vm-restart',
				state,
				zoneId: observation.zoneId,
			});
		},
		recordGatewayControlSessionObservation(observation): GatewayVmRecoveryDecision {
			const state = getStateForZone(observation.zoneId);
			if (observation.result === 'unobserved') {
				return {
					consecutiveFailures: state.gatewayControlSessionConsecutiveFailures,
					kind: 'none',
					reason: 'unobserved',
				};
			}
			if (isHealthyObservation(observation.result)) {
				state.gatewayControlSessionConsecutiveFailures = 0;
				state.gatewayControlSessionRecoveryDue = false;
				state.gatewayControlSessionRecoveryDueAtMs = undefined;
				if (observation.sourceKey !== undefined) {
					recordGatewayRecoverySource(state, observation.sourceKey);
				}
				if (
					state.stabilizingRecovery !== undefined &&
					state.stabilizingRecovery.boundSourceKey === state.gatewayRecoverySourceKey
				) {
					state.stabilizingRecovery.controlSessionHealthyObservations += 1;
					maybeFinishGatewayRecoveryStabilization({
						observedAtMs: observation.observedAtMs,
						policy: options.policy,
						state,
					});
				}
				return { consecutiveFailures: 0, kind: 'none' };
			}
			if (isDegradedObservation(observation.result)) {
				if (state.stabilizingRecovery !== undefined) {
					state.stabilizingRecovery.controlSessionHealthyObservations = 0;
				}
				if (observation.sourceKey === undefined) {
					return {
						consecutiveFailures: state.gatewayControlSessionConsecutiveFailures,
						kind: 'none',
						reason: 'missing-source-key',
					};
				}
				recordGatewayRecoverySource(state, observation.sourceKey);
				state.gatewayControlSessionConsecutiveFailures += 1;
			}
			if (observation.controlSessionDeathGrace !== 'recovery-due') {
				state.gatewayControlSessionRecoveryDue = false;
				state.gatewayControlSessionRecoveryDueAtMs = undefined;
				return {
					consecutiveFailures: state.gatewayControlSessionConsecutiveFailures,
					kind: 'none',
					reason:
						observation.controlSessionDeathGrace === 'within-grace'
							? 'within-grace'
							: 'needs-corroboration',
				};
			}
			state.gatewayControlSessionRecoveryDue = true;
			state.gatewayControlSessionRecoveryDueAtMs = observation.observedAtMs;
			return decideCorroboratedGatewayRecovery({
				observedAtMs: observation.observedAtMs,
				policy: options.policy,
				recoveryBudgetClass: observation.recoveryBudgetClass ?? 'gateway-vm-restart',
				state,
				zoneId: observation.zoneId,
			});
		},
		recordGatewayServiceProbe(observation): GatewayVmRecoveryDecision {
			const state = getStateForZone(observation.zoneId);
			if (isHealthyObservation(observation.result)) {
				state.gatewayServiceConsecutiveFailures = 0;
				state.gatewayServiceLastFailureAtMs = undefined;
				if (observation.sourceKey !== undefined) {
					recordGatewayRecoverySource(state, observation.sourceKey);
				}
				if (
					state.stabilizingRecovery !== undefined &&
					state.stabilizingRecovery.boundSourceKey === state.gatewayRecoverySourceKey
				) {
					state.stabilizingRecovery.serviceHealthyObservations += 1;
					maybeFinishGatewayRecoveryStabilization({
						observedAtMs: observation.observedAtMs,
						policy: options.policy,
						state,
					});
				}
				return { consecutiveFailures: 0, kind: 'none' };
			}
			if (isDegradedObservation(observation.result)) {
				if (state.stabilizingRecovery !== undefined) {
					state.stabilizingRecovery.serviceHealthyObservations = 0;
				}
				state.gatewayServiceConsecutiveFailures += 1;
				state.gatewayServiceLastFailureAtMs = observation.observedAtMs;
			}
			return decideCorroboratedGatewayRecovery({
				observedAtMs: observation.observedAtMs,
				policy: options.policy,
				recoveryBudgetClass: observation.recoveryBudgetClass ?? 'gateway-vm-restart',
				state,
				zoneId: observation.zoneId,
			});
		},
	};
}
