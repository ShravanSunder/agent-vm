import type { GatewayRecoveryHealthReason } from '@agent-vm/gateway-interface';

export type GatewayVmRecoveryObservationResult =
	| 'failed'
	| 'ok'
	| 'stale'
	| 'timeout'
	| 'unobserved';

export type GatewayVmRecoveryReason = GatewayRecoveryHealthReason;
export type GatewayVmRecoveryBudgetClass = 'gateway-vm-cold-start' | 'gateway-vm-restart';

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
	restartGatewayOnRecoverable: true,
	restartGatewayOnUnrecoverable: false,
	transitioningTimeoutMs: 120_000,
} satisfies GatewayVmChannelProviderRecoveryPolicy;

export interface CreateGatewayVmRecoveryTrackerOptions {
	readonly policy: GatewayVmAutoRecoveryPolicy;
}

export interface GatewayVmRecoveryObservation {
	readonly observedAtMs: number;
	readonly recoveryBudgetClass?: GatewayVmRecoveryBudgetClass | undefined;
	readonly result: GatewayVmRecoveryObservationResult;
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
			readonly reason?: 'cooldown' | 'disabled' | 'in-flight' | 'unobserved' | undefined;
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
			readonly reason: 'max-failed-recoveries';
			readonly zoneId: string;
	  };

export interface GatewayVmRecoveryTracker {
	readonly markRecoveryFinished: (event: GatewayVmRecoveryLifecycleEvent) => void;
	readonly markRecoveryStarted: (event: GatewayVmRecoveryLifecycleEvent) => void;
	readonly recordAgentChannelProviderObservation: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
	readonly recordGatewayControlLinkObservation: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
	readonly recordGatewayServiceProbe: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
}

interface GatewayVmRecoveryTrackerState {
	agentChannelProviderConsecutiveFailures: number;
	gatewayControlLinkConsecutiveFailures: number;
	gatewayServiceConsecutiveFailures: number;
	recoveryBudgets: Record<GatewayVmRecoveryBudgetClass, GatewayVmRecoveryBudgetState>;
	recoveryInFlight: boolean;
}

interface GatewayVmRecoveryBudgetState {
	consecutiveFailedRecoveries: number;
	lastRecoveryAttemptAtMs: number | undefined;
}

function createInitialGatewayVmRecoveryBudgetState(): GatewayVmRecoveryBudgetState {
	return {
		consecutiveFailedRecoveries: 0,
		lastRecoveryAttemptAtMs: undefined,
	};
}

const createInitialGatewayVmRecoveryTrackerState = (): GatewayVmRecoveryTrackerState => ({
	agentChannelProviderConsecutiveFailures: 0,
	gatewayControlLinkConsecutiveFailures: 0,
	gatewayServiceConsecutiveFailures: 0,
	recoveryBudgets: {
		'gateway-vm-cold-start': createInitialGatewayVmRecoveryBudgetState(),
		'gateway-vm-restart': createInitialGatewayVmRecoveryBudgetState(),
	},
	recoveryInFlight: false,
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
	}
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
	if (props.consecutiveFailures < props.policy.consecutiveFailureThreshold) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none' };
	}
	const budgetState = props.state.recoveryBudgets[props.recoveryBudgetClass];
	if (isWithinCooldown(budgetState, props.policy, props.observedAtMs)) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none', reason: 'cooldown' };
	}
	resetFailedRecoveriesIfSuspensionExpired(budgetState, props.policy, props.observedAtMs);
	if (hasActiveRecoverySuspension(budgetState, props.policy, props.observedAtMs)) {
		return {
			consecutiveFailedRecoveries: budgetState.consecutiveFailedRecoveries,
			consecutiveFailures: props.consecutiveFailures,
			kind: 'suspended',
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
				state.agentChannelProviderConsecutiveFailures = 0;
				state.gatewayControlLinkConsecutiveFailures = 0;
				state.gatewayServiceConsecutiveFailures = 0;
				for (const budgetState of Object.values(state.recoveryBudgets)) {
					budgetState.consecutiveFailedRecoveries = 0;
				}
				return;
			}
			if (event.result === 'failed') {
				state.recoveryBudgets[recoveryBudgetClassForEvent(event)].consecutiveFailedRecoveries += 1;
			}
		},
		markRecoveryStarted(event): void {
			const state = getStateForZone(event.zoneId);
			state.recoveryBudgets[recoveryBudgetClassForEvent(event)].lastRecoveryAttemptAtMs =
				event.observedAtMs;
			state.recoveryInFlight = true;
		},
		recordAgentChannelProviderObservation(observation): GatewayVmRecoveryDecision {
			const channelProviderPolicy =
				options.policy.channelProviderHealth ?? defaultGatewayVmChannelProviderRecoveryPolicy;
			const state = getStateForZone(observation.zoneId);
			if (observation.result === 'unobserved') {
				return {
					consecutiveFailures: state.agentChannelProviderConsecutiveFailures,
					kind: 'none',
					reason: 'unobserved',
				};
			}
			if (isHealthyObservation(observation.result)) {
				state.agentChannelProviderConsecutiveFailures = 0;
				return { consecutiveFailures: 0, kind: 'none' };
			}
			if (isDegradedObservation(observation.result)) {
				state.agentChannelProviderConsecutiveFailures += 1;
			}
			return decideRecovery({
				consecutiveFailures: state.agentChannelProviderConsecutiveFailures,
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
		recordGatewayControlLinkObservation(observation): GatewayVmRecoveryDecision {
			const state = getStateForZone(observation.zoneId);
			if (observation.result === 'unobserved') {
				return {
					consecutiveFailures: state.gatewayControlLinkConsecutiveFailures,
					kind: 'none',
					reason: 'unobserved',
				};
			}
			if (isHealthyObservation(observation.result)) {
				state.gatewayControlLinkConsecutiveFailures = 0;
				return { consecutiveFailures: 0, kind: 'none' };
			}
			if (isDegradedObservation(observation.result)) {
				state.gatewayControlLinkConsecutiveFailures += 1;
			}
			return decideRecovery({
				consecutiveFailures: state.gatewayControlLinkConsecutiveFailures,
				observedAtMs: observation.observedAtMs,
				policy: options.policy,
				reason: 'gateway-control-link-unhealthy',
				recoveryBudgetClass: observation.recoveryBudgetClass ?? 'gateway-vm-restart',
				state,
				zoneId: observation.zoneId,
			});
		},
		recordGatewayServiceProbe(observation): GatewayVmRecoveryDecision {
			const state = getStateForZone(observation.zoneId);
			if (isHealthyObservation(observation.result)) {
				state.gatewayServiceConsecutiveFailures = 0;
				return { consecutiveFailures: 0, kind: 'none' };
			}
			if (isDegradedObservation(observation.result)) {
				state.gatewayServiceConsecutiveFailures += 1;
			}
			return decideRecovery({
				consecutiveFailures: state.gatewayServiceConsecutiveFailures,
				observedAtMs: observation.observedAtMs,
				policy: options.policy,
				reason: 'gateway-service-unhealthy',
				recoveryBudgetClass: observation.recoveryBudgetClass ?? 'gateway-vm-restart',
				state,
				zoneId: observation.zoneId,
			});
		},
	};
}
