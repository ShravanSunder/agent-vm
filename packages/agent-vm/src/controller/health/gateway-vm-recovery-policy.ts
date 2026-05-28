import type { GatewayRecoveryHealthReason } from '@agent-vm/gateway-interface';

export type GatewayVmRecoveryObservationResult =
	| 'failed'
	| 'ok'
	| 'stale'
	| 'timeout'
	| 'unobserved';

export type GatewayVmRecoveryReason = GatewayRecoveryHealthReason;

export interface GatewayVmAutoRecoveryPolicy {
	readonly consecutiveFailureThreshold: number;
	readonly cooldownMs: number;
	readonly enabled: boolean;
	readonly failedRecoveryResetMs: number;
	readonly maxConsecutiveFailedRecoveries: number;
	readonly restartTimeoutMs: number;
}

export interface CreateGatewayVmRecoveryTrackerOptions {
	readonly policy: GatewayVmAutoRecoveryPolicy;
}

export interface GatewayVmRecoveryObservation {
	readonly observedAtMs: number;
	readonly result: GatewayVmRecoveryObservationResult;
	readonly zoneId: string;
}

export interface GatewayVmRecoveryLifecycleEvent {
	readonly observedAtMs: number;
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
	readonly recordGatewayControlLinkObservation: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
	readonly recordGatewayServiceProbe: (
		observation: GatewayVmRecoveryObservation,
	) => GatewayVmRecoveryDecision;
}

interface GatewayVmRecoveryTrackerState {
	consecutiveFailedRecoveries: number;
	gatewayControlLinkConsecutiveFailures: number;
	gatewayServiceConsecutiveFailures: number;
	lastRecoveryAttemptAtMs: number | undefined;
	recoveryInFlight: boolean;
}

const createInitialGatewayVmRecoveryTrackerState = (): GatewayVmRecoveryTrackerState => ({
	consecutiveFailedRecoveries: 0,
	gatewayControlLinkConsecutiveFailures: 0,
	gatewayServiceConsecutiveFailures: 0,
	lastRecoveryAttemptAtMs: undefined,
	recoveryInFlight: false,
});

function isHealthyObservation(result: GatewayVmRecoveryObservationResult): boolean {
	return result === 'ok';
}

function isDegradedObservation(result: GatewayVmRecoveryObservationResult): boolean {
	return result === 'failed' || result === 'stale' || result === 'timeout';
}

function isWithinCooldown(
	state: GatewayVmRecoveryTrackerState,
	policy: GatewayVmAutoRecoveryPolicy,
	observedAtMs: number,
): boolean {
	return (
		state.lastRecoveryAttemptAtMs !== undefined &&
		observedAtMs - state.lastRecoveryAttemptAtMs < policy.cooldownMs
	);
}

function hasActiveRecoverySuspension(
	state: GatewayVmRecoveryTrackerState,
	policy: GatewayVmAutoRecoveryPolicy,
	observedAtMs: number,
): boolean {
	return (
		state.consecutiveFailedRecoveries >= policy.maxConsecutiveFailedRecoveries &&
		state.lastRecoveryAttemptAtMs !== undefined &&
		observedAtMs - state.lastRecoveryAttemptAtMs < policy.failedRecoveryResetMs
	);
}

function resetFailedRecoveriesIfSuspensionExpired(
	state: GatewayVmRecoveryTrackerState,
	policy: GatewayVmAutoRecoveryPolicy,
	observedAtMs: number,
): void {
	if (
		state.consecutiveFailedRecoveries >= policy.maxConsecutiveFailedRecoveries &&
		state.lastRecoveryAttemptAtMs !== undefined &&
		observedAtMs - state.lastRecoveryAttemptAtMs >= policy.failedRecoveryResetMs
	) {
		state.consecutiveFailedRecoveries = 0;
	}
}

function decideRecovery(props: {
	readonly consecutiveFailures: number;
	readonly observedAtMs: number;
	readonly policy: GatewayVmAutoRecoveryPolicy;
	readonly reason: GatewayVmRecoveryReason;
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
	if (isWithinCooldown(props.state, props.policy, props.observedAtMs)) {
		return { consecutiveFailures: props.consecutiveFailures, kind: 'none', reason: 'cooldown' };
	}
	resetFailedRecoveriesIfSuspensionExpired(props.state, props.policy, props.observedAtMs);
	if (hasActiveRecoverySuspension(props.state, props.policy, props.observedAtMs)) {
		return {
			consecutiveFailedRecoveries: props.state.consecutiveFailedRecoveries,
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
				state.consecutiveFailedRecoveries = 0;
				state.gatewayControlLinkConsecutiveFailures = 0;
				state.gatewayServiceConsecutiveFailures = 0;
				return;
			}
			if (event.result === 'failed') {
				state.consecutiveFailedRecoveries += 1;
			}
		},
		markRecoveryStarted(event): void {
			const state = getStateForZone(event.zoneId);
			state.lastRecoveryAttemptAtMs = event.observedAtMs;
			state.recoveryInFlight = true;
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
				state,
				zoneId: observation.zoneId,
			});
		},
	};
}
