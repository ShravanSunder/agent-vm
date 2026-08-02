import { createHash } from 'node:crypto';

import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';

export type TelemetryAttributeValue = boolean | number | string;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export interface HealthEventTelemetryLog {
	readonly attributes: TelemetryAttributes;
	readonly message: string;
	readonly observedAtMs: number;
}

export interface HealthEventTelemetryMetricSample {
	readonly attributes: TelemetryAttributes;
	readonly name: 'agent_vm_health_event_duration_ms' | 'agent_vm_health_events_total';
	readonly value: number;
}

export interface HealthEventTelemetryRecord {
	readonly log: HealthEventTelemetryLog;
	readonly metricSamples: readonly HealthEventTelemetryMetricSample[];
}

const forbiddenAttributeSubstrings = ['api_key', 'password', 'secret', 'token'] as const;

export function mapHealthEventToTelemetry(event: AgentVmHealthEvent): HealthEventTelemetryRecord {
	const baseAttributes: Record<string, TelemetryAttributeValue> = {
		'agent_vm.health.kind': event.kind,
		'agent_vm.health.result': event.result,
		'agent_vm.zone.id': event.zoneId,
	};
	const lowCardinalityAttributes = { ...baseAttributes };

	if ('elapsedMs' in event) {
		baseAttributes['agent_vm.health.elapsed_ms'] = event.elapsedMs;
	}
	if ('statusCode' in event && event.statusCode !== undefined) {
		baseAttributes['http.response.status_code'] = event.statusCode;
	}
	if ('errorCode' in event && typeof event.errorCode === 'string') {
		addSafeErrorCode(baseAttributes, event.errorCode);
	}

	addCorrelationAttributes(baseAttributes, event);
	addKindSpecificAttributes(baseAttributes, event);

	const metricSamples: HealthEventTelemetryMetricSample[] = [
		{
			attributes: lowCardinalityAttributes,
			name: 'agent_vm_health_events_total',
			value: 1,
		},
	];
	if ('elapsedMs' in event) {
		metricSamples.push({
			attributes: lowCardinalityAttributes,
			name: 'agent_vm_health_event_duration_ms',
			value: event.elapsedMs,
		});
	}

	return {
		log: {
			attributes: baseAttributes,
			message: `agent-vm health ${event.kind} ${event.result}`,
			observedAtMs: event.observedAtMs,
		},
		metricSamples,
	};
}

function addCorrelationAttributes(
	attributes: Record<string, TelemetryAttributeValue>,
	event: AgentVmHealthEvent,
): void {
	if (event.traceId !== undefined) {
		attributes['agent_vm.trace.id'] = event.traceId;
	}
	if (event.correlationId !== undefined) {
		attributes['agent_vm.correlation.id'] = event.correlationId;
	}
	if (event.causationId !== undefined) {
		attributes['agent_vm.causation.id'] = event.causationId;
	}
	if (event.requestId !== undefined) {
		attributes['agent_vm.request.id'] = event.requestId;
	}
	if (event.runId !== undefined) {
		attributes['agent_vm.run.id'] = event.runId;
	}
	if (event.sessionKeyDigest !== undefined) {
		attributes['agent_vm.session_key.digest'] = event.sessionKeyDigest;
	}
	if (event.toolCallId !== undefined) {
		attributes['agent_vm.tool_call.id'] = event.toolCallId;
	}
}

function addKindSpecificAttributes(
	attributes: Record<string, TelemetryAttributeValue>,
	event: AgentVmHealthEvent,
): void {
	switch (event.kind) {
		case 'caller-context-rejection':
			attributes['agent_vm.caller_context.operation'] = event.operation;
			attributes['agent_vm.caller_context.rejection_reason'] = event.reason;
			return;
		case 'agent-channel-provider-health':
			attributes['agent_vm.agent_channel.health'] = event.health;
			attributes['agent_vm.agent_channel.provider_id_hash'] = stableTelemetryHash(
				event.channelProviderId,
			);
			if (event.transitionStartedAtMs !== undefined) {
				attributes['agent_vm.agent_channel.transition_started_at_ms'] = event.transitionStartedAtMs;
			}
			if (event.unhealthySinceMs !== undefined) {
				attributes['agent_vm.agent_channel.unhealthy_since_ms'] = event.unhealthySinceMs;
			}
			return;
		case 'controller-request':
			attributes['agent_vm.controller.operation'] = event.operation;
			attributes['agent_vm.controller.attempt'] = event.attempt;
			attributes['agent_vm.controller.max_attempts'] = event.maxAttempts;
			return;
		case 'gateway-control-session':
			attributes['agent_vm.gateway.operation'] = event.operation;
			if (event.reconnectPhase !== undefined) {
				attributes['agent_vm.gateway.control.attempt_count'] = event.attemptCount;
				attributes['agent_vm.gateway.control.boot_id_hash'] = stableTelemetryHash(event.bootId);
				attributes['agent_vm.gateway.control.first_observed_at_ms'] = event.firstObservedAtMs;
				attributes['agent_vm.gateway.control.latest_observed_at_ms'] = event.latestObservedAtMs;
				attributes['agent_vm.gateway.control.outcome'] = event.outcome;
				attributes['agent_vm.gateway.control.peer_id_hash'] = stableTelemetryHash(event.peerId);
				attributes['agent_vm.gateway.control.reconnect_phase'] = event.reconnectPhase;
				attributes['agent_vm.gateway.control.window_state'] = event.windowState;
				if (event.nextRetryAtMs !== undefined) {
					attributes['agent_vm.gateway.control.next_retry_at_ms'] = event.nextRetryAtMs;
				}
				if (event.terminalReason !== undefined) {
					attributes['agent_vm.gateway.control.terminal_reason'] = event.terminalReason;
				}
			}
			return;
		case 'gateway-plugin-health':
			attributes['agent_vm.gateway.service'] = event.gatewayService;
			attributes['agent_vm.gateway.state'] = event.state;
			return;
		case 'gateway-recovery':
			attributes['agent_vm.gateway.recovery.action'] = event.action;
			attributes['agent_vm.gateway.recovery.consecutive_failures'] = event.consecutiveFailures;
			attributes['agent_vm.gateway.recovery.cooldown_ms'] = event.cooldownMs;
			attributes['agent_vm.gateway.recovery.reason'] = event.reason;
			if (event.operationId !== undefined) {
				attributes['agent_vm.gateway.recovery.operation_id_hash'] = stableTelemetryHash(
					event.operationId,
				);
			}
			return;
		case 'gateway-recovery-suspended':
			attributes['agent_vm.gateway.recovery.action'] = event.action;
			attributes['agent_vm.gateway.recovery.consecutive_failed_recoveries'] =
				event.consecutiveFailedRecoveries;
			attributes['agent_vm.gateway.recovery.consecutive_failures'] = event.consecutiveFailures;
			attributes['agent_vm.gateway.recovery.cooldown_ms'] = event.cooldownMs;
			attributes['agent_vm.gateway.recovery.failed_recovery_reset_ms'] =
				event.failedRecoveryResetMs;
			attributes['agent_vm.gateway.recovery.reason'] = event.reason;
			if (event.operationId !== undefined) {
				attributes['agent_vm.gateway.recovery.operation_id_hash'] = stableTelemetryHash(
					event.operationId,
				);
			}
			return;
		case 'gateway-service-health':
			if (event.statusCode !== undefined) {
				attributes['http.response.status_code'] = event.statusCode;
			}
			return;
		case 'lease-heartbeat':
			attributes['agent_vm.agent.id_hash'] = stableTelemetryHash(event.agentId);
			attributes['agent_vm.lease.id_hash'] = stableTelemetryHash(event.leaseId);
			attributes['agent_vm.lease.use_id_hash'] = stableTelemetryHash(event.useId);
			return;
		case 'lease-renew':
			attributes['agent_vm.agent.id_hash'] = stableTelemetryHash(event.agentId);
			attributes['agent_vm.lease.id_hash'] = stableTelemetryHash(event.leaseId);
			return;
		case 'tool-vm-ssh':
			attributes['agent_vm.agent.id_hash'] = stableTelemetryHash(event.agentId);
			attributes['agent_vm.lease.id_hash'] = stableTelemetryHash(event.leaseId);
			attributes['agent_vm.tool_vm.ssh.operation'] = event.operation;
			if (event.activeUseId !== undefined) {
				attributes['agent_vm.lease.active_use_id_hash'] = stableTelemetryHash(event.activeUseId);
			}
			if (event.callerContextState !== undefined) {
				attributes['agent_vm.lease.caller_context_state'] = event.callerContextState;
			}
			if (event.leaseRejectionReason !== undefined) {
				attributes['agent_vm.lease.rejection_reason'] = event.leaseRejectionReason;
			}
			if (event.lifecycleEventRole !== undefined) {
				attributes['agent_vm.lease.lifecycle_event_role'] = event.lifecycleEventRole;
			}
			if (event.lifecycleTransition !== undefined) {
				attributes['agent_vm.lease.lifecycle_transition'] = event.lifecycleTransition;
			}
			if (event.oldLeaseId !== undefined) {
				attributes['agent_vm.lease.old_id_hash'] = stableTelemetryHash(event.oldLeaseId);
			}
			if (event.replacementLeaseId !== undefined) {
				attributes['agent_vm.lease.replacement_id_hash'] = stableTelemetryHash(
					event.replacementLeaseId,
				);
			}
			if (event.transitionId !== undefined) {
				attributes['agent_vm.lease.transition_id_hash'] = stableTelemetryHash(event.transitionId);
			}
			return;
		default:
			assertNever(event);
	}
}

function addSafeErrorCode(
	attributes: Record<string, TelemetryAttributeValue>,
	errorCode: string,
): void {
	if (isSafeTelemetryCode(errorCode)) {
		attributes['error.type'] = errorCode;
		return;
	}

	attributes['error.type_hash'] = stableTelemetryHash(errorCode);
}

function isSafeTelemetryCode(value: string): boolean {
	if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/u.test(value)) {
		return false;
	}
	const lowercaseValue = value.toLowerCase();
	return !forbiddenAttributeSubstrings.some((substring) => lowercaseValue.includes(substring));
}

export function stableTelemetryHash(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function assertNever(value: never): never {
	throw new Error(`Unhandled health event kind: ${JSON.stringify(value)}`);
}
