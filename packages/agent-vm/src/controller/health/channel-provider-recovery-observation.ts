import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';

import type {
	GatewayVmRecoveryObservation,
	GatewayVmRecoveryReason,
} from './gateway-vm-recovery-policy.js';

export type AgentChannelProviderHealthEvent = Extract<
	AgentVmHealthEvent,
	{ readonly kind: 'agent-channel-provider-health' }
>;

export type ChannelProviderRecoveryObservation =
	| {
			readonly kind: 'record-observation';
			readonly observation: GatewayVmRecoveryObservation;
			readonly reason?: GatewayVmRecoveryReason | undefined;
	  }
	| {
			readonly kind: 'observe-only';
			readonly reason:
				| 'channel-provider-restart-disabled'
				| 'channel-provider-transitioning'
				| 'channel-provider-unrecoverable';
	  };

export interface DeriveChannelProviderRecoveryObservationOptions {
	readonly allowRestartWhenUnrecoverable?: boolean | undefined;
	readonly event: AgentChannelProviderHealthEvent;
	readonly nowMs: number;
	readonly restartGatewayOnRecoverable?: boolean | undefined;
	readonly staleAfterMs: number;
	readonly transitioningTimeoutMs: number;
}

export function deriveChannelProviderRecoveryObservation(
	options: DeriveChannelProviderRecoveryObservationOptions,
): ChannelProviderRecoveryObservation {
	switch (options.event.health) {
		case 'healthy':
			if (isStaleChannelProviderEvent(options)) {
				return staleChannelProviderObservation(options.nowMs, options.event.zoneId);
			}
			return {
				kind: 'record-observation',
				observation: {
					observedAtMs: options.event.observedAtMs,
					result: 'ok',
					zoneId: options.event.zoneId,
				},
			};
		case 'transitioning':
			return deriveTransitioningChannelProviderObservation(options);
		case 'unhealthy-recoverable':
			if (isStaleChannelProviderEvent(options)) {
				return staleChannelProviderObservation(options.nowMs, options.event.zoneId);
			}
			return options.restartGatewayOnRecoverable === false
				? { kind: 'observe-only', reason: 'channel-provider-restart-disabled' }
				: failedChannelProviderObservation(options.event.observedAtMs, options.event.zoneId);
		case 'unhealthy-unrecoverable':
			return options.allowRestartWhenUnrecoverable === true
				? failedChannelProviderObservation(options.event.observedAtMs, options.event.zoneId)
				: { kind: 'observe-only', reason: 'channel-provider-unrecoverable' };
	}
	return assertNeverAgentChannelProviderHealth(options.event.health);
}

function isStaleChannelProviderEvent(
	options: DeriveChannelProviderRecoveryObservationOptions,
): boolean {
	return options.nowMs - options.event.observedAtMs > options.staleAfterMs;
}

function deriveTransitioningChannelProviderObservation(
	options: DeriveChannelProviderRecoveryObservationOptions,
): ChannelProviderRecoveryObservation {
	const transitionStartedAtMs = options.event.transitionStartedAtMs ?? options.event.observedAtMs;
	if (options.nowMs - transitionStartedAtMs <= options.transitioningTimeoutMs) {
		return { kind: 'observe-only', reason: 'channel-provider-transitioning' };
	}
	return failedChannelProviderObservation(options.nowMs, options.event.zoneId);
}

function failedChannelProviderObservation(
	observedAtMs: number,
	zoneId: string,
): ChannelProviderRecoveryObservation {
	return {
		kind: 'record-observation',
		observation: {
			observedAtMs,
			result: 'failed',
			zoneId,
		},
		reason: 'agent-channel-provider-unhealthy',
	};
}

function staleChannelProviderObservation(
	observedAtMs: number,
	zoneId: string,
): ChannelProviderRecoveryObservation {
	return {
		kind: 'record-observation',
		observation: {
			observedAtMs,
			result: 'stale',
			zoneId,
		},
		reason: 'agent-channel-provider-unhealthy',
	};
}

function assertNeverAgentChannelProviderHealth(health: never): never {
	throw new Error(`Unhandled agent channel provider health: ${String(health)}`);
}
