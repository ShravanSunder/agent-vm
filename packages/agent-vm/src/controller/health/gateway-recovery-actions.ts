import type {
	GatewayLifecycleErrorCode,
	GatewayZoneLifecycleState,
} from '../zone-runtimes/gateway-zone-state-machine.js';
import type {
	GatewayVmRecoveryDecision,
	GatewayVmRecoveryReason,
} from './gateway-vm-recovery-policy.js';

export type GatewayRecoveryDecisionAction =
	| { readonly kind: 'restart-running-gateway'; readonly reason: GatewayVmRecoveryReason }
	| { readonly kind: 'cold-start-gateway'; readonly reason: GatewayVmRecoveryReason }
	| { readonly kind: 'refresh-secret-resolver'; readonly reason: 'secret-resolution-failed' }
	| { readonly errorCode: 'max-failed-recoveries'; readonly kind: 'suspend-recovery' }
	| {
			readonly kind: 'operator-required';
			readonly reason: 'ambiguous-runtime-state' | 'owner-unsafe';
	  }
	| {
			readonly kind: 'observe-only';
			readonly reason:
				| 'recovery-disabled'
				| 'recovery-in-flight'
				| 'recovery-unobserved'
				| 'channel-provider-unrecoverable'
				| 'cooldown-active';
	  };

export interface ClassifyGatewayRecoveryActionOptions {
	readonly lifecycleState: GatewayZoneLifecycleState;
	readonly recoveryDecision: GatewayVmRecoveryDecision;
}

export function classifyGatewayRecoveryAction(
	options: ClassifyGatewayRecoveryActionOptions,
): GatewayRecoveryDecisionAction {
	if (options.recoveryDecision.kind === 'suspended') {
		return {
			errorCode: options.recoveryDecision.reason,
			kind: 'suspend-recovery',
		};
	}
	if (options.recoveryDecision.kind === 'none') {
		return {
			kind: 'observe-only',
			reason: classifyNoRecoveryReason(options.recoveryDecision.reason),
		};
	}

	const recoveryReason = options.recoveryDecision.reason;
	switch (options.lifecycleState.kind) {
		case 'running':
		case 'running-degraded':
			return { kind: 'restart-running-gateway', reason: recoveryReason };
		case 'stopped':
			return { kind: 'cold-start-gateway', reason: recoveryReason };
		case 'failed':
			return classifyFailedGatewayRecoveryAction(options.lifecycleState, recoveryReason);
		case 'owner-unsafe':
			return { kind: 'operator-required', reason: 'owner-unsafe' };
		case 'restarting':
		case 'starting':
		case 'stopping':
			return { kind: 'observe-only', reason: 'recovery-in-flight' };
	}
	return assertNeverGatewayZoneLifecycleState(options.lifecycleState);
}

function classifyFailedGatewayRecoveryAction(
	state: Extract<GatewayZoneLifecycleState, { readonly kind: 'failed' }>,
	recoveryReason: GatewayVmRecoveryReason,
): GatewayRecoveryDecisionAction {
	if (state.error.code === 'secret-resolution-failed') {
		return { kind: 'refresh-secret-resolver', reason: state.error.code };
	}
	if (state.error.code === 'owner-unsafe') {
		return { kind: 'operator-required', reason: 'owner-unsafe' };
	}
	if (state.coldStartEligible) {
		return { kind: 'cold-start-gateway', reason: recoveryReason };
	}
	if (isUnrecoverableFailure(state.error.code)) {
		return { kind: 'observe-only', reason: 'channel-provider-unrecoverable' };
	}
	return { kind: 'operator-required', reason: 'ambiguous-runtime-state' };
}

function isUnrecoverableFailure(errorCode: GatewayLifecycleErrorCode): boolean {
	return errorCode === 'agent-channel-provider-unhealthy';
}

function classifyNoRecoveryReason(
	reason: Extract<GatewayVmRecoveryDecision, { readonly kind: 'none' }>['reason'],
): Extract<GatewayRecoveryDecisionAction, { readonly kind: 'observe-only' }>['reason'] {
	switch (reason) {
		case 'cooldown':
			return 'cooldown-active';
		case 'disabled':
			return 'recovery-disabled';
		case 'in-flight':
			return 'recovery-in-flight';
		case 'unobserved':
			return 'recovery-unobserved';
		case undefined:
			return 'recovery-unobserved';
	}
	return assertNeverNoRecoveryReason(reason);
}

function assertNeverGatewayZoneLifecycleState(state: never): never {
	throw new Error(`Unhandled gateway zone lifecycle state: ${JSON.stringify(state)}`);
}

function assertNeverNoRecoveryReason(reason: never): never {
	throw new Error(`Unhandled gateway recovery none reason: ${String(reason)}`);
}
