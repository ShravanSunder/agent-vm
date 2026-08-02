import { gatewayTypeValues, type GatewayType } from '../gateway-runtime-contract.js';
import {
	genericControllerRequestEventOperations,
	type GenericControllerRequestEventOperation,
} from './controller-request-policy.js';

export const agentVmHealthEventKinds = [
	'gateway-service-health',
	'gateway-control-session',
	'controller-request',
	'lease-renew',
	'lease-heartbeat',
	'caller-context-rejection',
	'tool-vm-ssh',
	'gateway-plugin-health',
	'agent-channel-provider-health',
	'gateway-recovery',
	'gateway-recovery-suspended',
] as const;

export type AgentVmHealthEventKind = (typeof agentVmHealthEventKinds)[number];

export const agentVmHealthResultKinds = ['ok', 'failed', 'timeout', 'stale'] as const;

export type AgentVmHealthResultKind = (typeof agentVmHealthResultKinds)[number];

export interface AgentVmHealthEventBase {
	readonly causationId?: string | undefined;
	readonly correlationId?: string | undefined;
	readonly observedAtMs: number;
	readonly requestId?: string | undefined;
	readonly result: AgentVmHealthResultKind;
	readonly runId?: string | undefined;
	readonly sessionKeyDigest?: string | undefined;
	readonly toolCallId?: string | undefined;
	readonly traceId?: string | undefined;
	readonly zoneId: string;
}

export type ToolVmSshHealthOperation = 'command' | 'file-bridge' | 'finalize' | 'probe';

export const toolVmLeaseLifecycleEventRoles = ['plugin_observation', 'controller_final'] as const;

export type ToolVmLeaseLifecycleEventRole = (typeof toolVmLeaseLifecycleEventRoles)[number];

export const toolVmLeaseLifecycleTransitions = [
	'current_to_stale',
	'current_to_retired',
	'deprecated_to_reacquired',
	'deprecated_to_retired',
	'stale_to_reacquired',
	'stale_to_retired',
	'retired_rejected',
] as const;

export type ToolVmLeaseLifecycleTransition = (typeof toolVmLeaseLifecycleTransitions)[number];

const toolVmLeaseReacquiredLifecycleTransitions = [
	'deprecated_to_reacquired',
	'stale_to_reacquired',
] as const satisfies readonly ToolVmLeaseLifecycleTransition[];

type ToolVmLeaseReacquiredLifecycleTransition =
	(typeof toolVmLeaseReacquiredLifecycleTransitions)[number];

type ToolVmLeaseNonReacquiredLifecycleTransition = Exclude<
	ToolVmLeaseLifecycleTransition,
	ToolVmLeaseReacquiredLifecycleTransition
>;

export const toolVmLeaseCallerContextStates = [
	'ok',
	'absent',
	'stale',
	'session_mismatch',
	'not_applicable',
] as const;

export type ToolVmLeaseCallerContextState = (typeof toolVmLeaseCallerContextStates)[number];

export const toolVmLeaseRejectionReasons = [
	'caller_context_absent',
	'caller_context_session_mismatch',
	'caller_context_stale',
	'lease_absent',
	'lease_authority_absent',
	'lease_force_released',
	'lease_generation_stale',
	'lease_reacquire_required',
	'lease_releasing',
	'lease_retired',
	'lease_use_tombstoned',
	'ownership_denied',
	'runtime_not_ready',
] as const;

export type ToolVmLeaseRejectionReason = (typeof toolVmLeaseRejectionReasons)[number];

interface ToolVmLeaseLifecycleEvidenceBase {
	readonly activeUseId?: string | undefined;
	readonly callerContextState?: ToolVmLeaseCallerContextState | undefined;
	readonly leaseRejectionReason?: ToolVmLeaseRejectionReason | undefined;
	readonly lifecycleEventRole: ToolVmLeaseLifecycleEventRole;
	readonly oldLeaseId: string;
	readonly transitionId: string;
}

type ToolVmLeaseLifecycleEvidence =
	| (ToolVmLeaseLifecycleEvidenceBase & {
			readonly lifecycleTransition: ToolVmLeaseReacquiredLifecycleTransition;
			readonly replacementLeaseId: string;
	  })
	| (ToolVmLeaseLifecycleEvidenceBase & {
			readonly lifecycleTransition: ToolVmLeaseNonReacquiredLifecycleTransition;
			readonly replacementLeaseId?: undefined;
	  });

interface ToolVmLeaseLifecycleAbsentEvidence {
	readonly activeUseId?: undefined;
	readonly callerContextState?: undefined;
	readonly leaseRejectionReason?: undefined;
	readonly lifecycleEventRole?: undefined;
	readonly lifecycleTransition?: undefined;
	readonly oldLeaseId?: undefined;
	readonly replacementLeaseId?: undefined;
	readonly transitionId?: undefined;
}

export const agentChannelProviderHealthKinds = [
	'healthy',
	'transitioning',
	'unhealthy-recoverable',
	'unhealthy-unrecoverable',
] as const;

export type AgentChannelProviderHealthKind = (typeof agentChannelProviderHealthKinds)[number];

export const agentChannelProviderHealthDetailKeys = [
	'closeCode',
	'providerType',
	'reconnectAttempt',
	'reconnecting',
	'sleepResumeSuspected',
	'statusCode',
] as const;

export type AgentChannelProviderHealthDetailKey =
	(typeof agentChannelProviderHealthDetailKeys)[number];

export type AgentChannelProviderHealthDetails = Readonly<
	Partial<Record<AgentChannelProviderHealthDetailKey, boolean | number | string>>
>;

export const gatewayRecoveryHealthReasons = [
	'agent-channel-provider-unhealthy',
	'gateway-control-session-unhealthy',
	'gateway-service-unhealthy',
] as const;

export type GatewayRecoveryHealthReason = (typeof gatewayRecoveryHealthReasons)[number];
export type GatewayRecoveryVmAction = 'gateway-vm-cold-start' | 'gateway-vm-restart';
export type GatewayRecoveryEventAction =
	| GatewayRecoveryVmAction
	| 'observe-only'
	| 'operator-required';
export type GatewayRecoveryTimeoutErrorCode = 'recovery-callback-unconfigured' | 'recovery-timeout';

export const gatewayControlSessionHealthOperations = [
	'control-session-hello',
	'control-session-heartbeat',
	'control-session-disconnect',
	'control-session-reconnect',
] as const;

export type GatewayControlSessionHealthOperation =
	(typeof gatewayControlSessionHealthOperations)[number];

export const gatewayControlSessionReconnectPhases = [
	'attachment-lost',
	'attempt-started',
	'attempt-failed',
	'retry-scheduled',
	'accepted',
	'stabilizing',
	'stable',
] as const;

export type GatewayControlSessionReconnectPhase =
	(typeof gatewayControlSessionReconnectPhases)[number];

export const gatewayControlSessionReconnectOutcomes = [
	'transport-error',
	'timeout',
	'accepted',
	'rejected',
	'generation-mismatch',
	'stale-attachment',
] as const;

export type GatewayControlSessionReconnectOutcome =
	(typeof gatewayControlSessionReconnectOutcomes)[number];

export const gatewayControlSessionReconnectTerminalReasons = [
	'accepted',
	'manager-disposed',
	'gateway-superseded',
	'controller-shutdown',
] as const;

export type GatewayControlSessionReconnectTerminalReason =
	(typeof gatewayControlSessionReconnectTerminalReasons)[number];

interface GatewayControlSessionReconnectEvidenceBase {
	readonly attemptCount: number;
	readonly bootId: string;
	readonly firstObservedAtMs: number;
	readonly latestObservedAtMs: number;
	readonly outcome: GatewayControlSessionReconnectOutcome;
	readonly reconnectPhase: GatewayControlSessionReconnectPhase;
}

type GatewayControlSessionReconnectEvidence =
	| (GatewayControlSessionReconnectEvidenceBase & {
			readonly nextRetryAtMs?: number | undefined;
			readonly terminalReason?: undefined;
			readonly windowState: 'open';
	  })
	| (GatewayControlSessionReconnectEvidenceBase & {
			readonly nextRetryAtMs?: undefined;
			readonly terminalReason: GatewayControlSessionReconnectTerminalReason;
			readonly windowState: 'closed';
	  });

interface GatewayControlSessionReconnectEvidenceAbsent {
	readonly attemptCount?: undefined;
	readonly firstObservedAtMs?: undefined;
	readonly latestObservedAtMs?: undefined;
	readonly nextRetryAtMs?: undefined;
	readonly outcome?: undefined;
	readonly reconnectPhase?: undefined;
	readonly terminalReason?: undefined;
	readonly windowState?: undefined;
}

export type AgentVmHealthEvent =
	| (AgentVmHealthEventBase & {
			readonly kind: 'caller-context-rejection';
			readonly operation:
				| 'lease_create'
				| 'lease_get'
				| 'lease_peek'
				| 'lease_reacquire'
				| 'lease_release'
				| 'lease_renew'
				| 'lease_use_end'
				| 'lease_use_heartbeat'
				| 'lease_use_start';
			readonly reason:
				| 'caller_context_absent'
				| 'caller_context_session_mismatch'
				| 'caller_context_stale';
			readonly result: 'failed';
	  })
	| (AgentVmHealthEventBase & {
			readonly kind: 'gateway-service-health';
			readonly path: string;
			readonly port: number;
			readonly statusCode?: number | undefined;
	  })
	| (AgentVmHealthEventBase &
			(GatewayControlSessionReconnectEvidence | GatewayControlSessionReconnectEvidenceAbsent) & {
				readonly bootId?: string | undefined;
				readonly connectionId?: string | undefined;
				readonly domain: 'gateway_control';
				readonly elapsedMs: number;
				readonly kind: 'gateway-control-session';
				readonly operation: GatewayControlSessionHealthOperation;
				readonly peerId: string;
				readonly sessionId?: string | undefined;
			})
	| (AgentVmHealthEventBase & {
			readonly attempt: number;
			readonly elapsedMs: number;
			readonly errorCode?: string | undefined;
			readonly kind: 'controller-request';
			readonly maxAttempts: number;
			readonly operation: GenericControllerRequestEventOperation;
			readonly statusCode?: number | undefined;
	  })
	| (AgentVmHealthEventBase & {
			readonly agentId: string;
			readonly elapsedMs: number;
			readonly errorCode?: string | undefined;
			readonly kind: 'lease-renew';
			readonly leaseId: string;
	  })
	| (AgentVmHealthEventBase & {
			readonly agentId: string;
			readonly elapsedMs: number;
			readonly errorCode?: string | undefined;
			readonly kind: 'lease-heartbeat';
			readonly leaseId: string;
			readonly useId: string;
	  })
	| (AgentVmHealthEventBase & {
			readonly agentId: string;
			readonly elapsedMs: number;
			readonly errorCode?: string | undefined;
			readonly kind: 'tool-vm-ssh';
			readonly leaseId: string;
			readonly operation: ToolVmSshHealthOperation;
	  } & (ToolVmLeaseLifecycleAbsentEvidence | ToolVmLeaseLifecycleEvidence))
	| (AgentVmHealthEventBase & {
			readonly gatewayService: GatewayType;
			readonly kind: 'gateway-plugin-health';
			readonly state: 'starting' | 'ready' | 'stopping' | 'failed';
	  })
	| (AgentVmHealthEventBase & {
			readonly channelProviderId: string;
			readonly details?: AgentChannelProviderHealthDetails | undefined;
			readonly health: AgentChannelProviderHealthKind;
			readonly kind: 'agent-channel-provider-health';
			readonly transitionStartedAtMs?: number | undefined;
			readonly unhealthySinceMs?: number | undefined;
	  })
	| (AgentVmHealthEventBase & {
			readonly action: 'gateway-vm-restart';
			readonly consecutiveFailures: number;
			readonly cooldownMs: number;
			readonly elapsedMs: number;
			readonly kind: 'gateway-recovery';
			readonly leaseReleaseFailureCount: number;
			readonly newBootedAt: string;
			readonly newHostPid: number;
			readonly newVmId: string;
			readonly oldBootedAt: string;
			readonly oldHostPid: number;
			readonly oldVmId: string;
			readonly operationId?: string | undefined;
			readonly reason: GatewayRecoveryHealthReason;
			readonly result: 'ok';
	  })
	| (AgentVmHealthEventBase & {
			readonly action: 'gateway-vm-cold-start';
			readonly consecutiveFailures: number;
			readonly cooldownMs: number;
			readonly elapsedMs: number;
			readonly kind: 'gateway-recovery';
			readonly leaseReleaseFailureCount: number;
			readonly newBootedAt: string;
			readonly newHostPid: number;
			readonly newVmId: string;
			readonly oldBootedAt?: undefined;
			readonly oldHostPid?: undefined;
			readonly oldVmId?: undefined;
			readonly operationId?: string | undefined;
			readonly reason: GatewayRecoveryHealthReason;
			readonly result: 'ok';
	  })
	| (AgentVmHealthEventBase & {
			readonly action: 'gateway-vm-restart';
			readonly consecutiveFailures: number;
			readonly cooldownMs: number;
			readonly elapsedMs: number;
			readonly errorCode: string;
			readonly kind: 'gateway-recovery';
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId: string;
			readonly operationId?: string | undefined;
			readonly reason: GatewayRecoveryHealthReason;
			readonly result: 'failed';
	  })
	| (AgentVmHealthEventBase & {
			readonly action: 'gateway-vm-restart';
			readonly consecutiveFailures: number;
			readonly cooldownMs: number;
			readonly elapsedMs: number;
			readonly errorCode: GatewayRecoveryTimeoutErrorCode;
			readonly kind: 'gateway-recovery';
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId?: string | undefined;
			readonly operationId?: string | undefined;
			readonly reason: GatewayRecoveryHealthReason;
			readonly result: 'failed';
	  })
	| (AgentVmHealthEventBase & {
			readonly action: 'gateway-vm-cold-start' | 'observe-only' | 'operator-required';
			readonly consecutiveFailures: number;
			readonly cooldownMs: number;
			readonly elapsedMs: number;
			readonly errorCode: string;
			readonly kind: 'gateway-recovery';
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly oldBootedAt?: undefined;
			readonly oldHostPid?: undefined;
			readonly oldVmId?: undefined;
			readonly operationId?: string | undefined;
			readonly reason: GatewayRecoveryHealthReason;
			readonly result: 'failed';
	  })
	| (AgentVmHealthEventBase & {
			readonly action: GatewayRecoveryEventAction;
			readonly consecutiveFailedRecoveries: number;
			readonly consecutiveFailures: number;
			readonly cooldownMs: number;
			readonly errorCode: 'max-failed-recoveries';
			readonly failedRecoveryResetMs: number;
			readonly kind: 'gateway-recovery-suspended';
			readonly operationId?: string | undefined;
			readonly reason: GatewayRecoveryHealthReason;
			readonly result: 'failed';
	  });

export const zoneHealthStateKinds = ['unknown', 'ok', 'stale', 'failed'] as const;

export type ZoneHealthStateKind = (typeof zoneHealthStateKinds)[number];

export const zoneHealthIssueKinds = [
	'gateway-service-unhealthy',
	'gateway-control-session-unhealthy',
	'controller-request-failing',
	'lease-heartbeat-failing',
	'lease-renew-failing',
	'tool-vm-ssh-failing',
	'gateway-plugin-unhealthy',
	'agent-channel-provider-unhealthy',
	'gateway-recovery-failed',
	'gateway-recovery-suspended',
	'health-event-stale',
] as const;

export type ZoneHealthIssueKind = (typeof zoneHealthIssueKinds)[number];

export interface ZoneHealthIssue {
	readonly kind: ZoneHealthIssueKind;
	readonly latestEvent: AgentVmHealthEvent;
	readonly message: string;
	readonly sinceMs: number;
}

export type ZoneHealthSnapshot =
	| {
			readonly kind: 'unknown';
			readonly reason: 'no-events';
			readonly zoneId: string;
	  }
	| {
			readonly kind: 'ok';
			readonly latestEvents: readonly AgentVmHealthEvent[];
			readonly zoneId: string;
	  }
	| {
			readonly issues: readonly ZoneHealthIssue[];
			readonly kind: 'stale' | 'failed';
			readonly latestEvents: readonly AgentVmHealthEvent[];
			readonly zoneId: string;
	  };

export interface DeriveZoneHealthSnapshotOptions {
	readonly nowMs: number;
	readonly staleAfterMs: number;
	readonly zoneId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<TValues extends readonly string[]>(
	values: TValues,
	value: unknown,
): value is TValues[number] {
	return typeof value === 'string' && values.includes(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasBaseEventFields(record: Record<string, unknown>): boolean {
	return (
		isNonNegativeFiniteNumber(record.observedAtMs) &&
		isOneOf(agentVmHealthResultKinds, record.result) &&
		typeof record.zoneId === 'string' &&
		record.zoneId.length > 0
	);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function optionalNonEmptyString(value: unknown): boolean {
	return value === undefined || (typeof value === 'string' && value.length > 0);
}

function optionalOneOf<TValues extends readonly string[]>(
	values: TValues,
	value: unknown,
): value is TValues[number] | undefined {
	return value === undefined || isOneOf(values, value);
}

function isToolVmLeaseReacquiredTransition(
	value: unknown,
): value is ToolVmLeaseReacquiredLifecycleTransition {
	return isOneOf(toolVmLeaseReacquiredLifecycleTransitions, value);
}

function optionalStatusCode(value: unknown): boolean {
	return value === undefined || Number.isInteger(value);
}

function optionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) > 0;
}

function isRedactedHealthDetails(value: unknown): value is AgentChannelProviderHealthDetails {
	if (value === undefined) {
		return true;
	}
	if (!isRecord(value)) {
		return false;
	}
	for (const [key, detailValue] of Object.entries(value)) {
		if (!isOneOf(agentChannelProviderHealthDetailKeys, key)) {
			return false;
		}
		if (!isChannelProviderHealthDetailValue(key, detailValue)) {
			return false;
		}
	}
	return true;
}

function isChannelProviderHealthDetailValue(
	key: AgentChannelProviderHealthDetailKey,
	value: unknown,
): boolean {
	switch (key) {
		case 'closeCode':
		case 'reconnectAttempt':
		case 'statusCode':
			return isNonNegativeInteger(value);
		case 'providerType':
			return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,31}$/iu.test(value);
		case 'reconnecting':
		case 'sleepResumeSuspected':
			return typeof value === 'boolean';
	}
	return assertNeverAgentChannelProviderHealthDetailKey(key);
}

function assertNeverAgentChannelProviderHealthDetailKey(key: never): never {
	throw new Error(`Unhandled agent channel provider health detail key: ${String(key)}`);
}

function isGatewayRecoveryTimeoutErrorCode(
	value: unknown,
): value is GatewayRecoveryTimeoutErrorCode {
	return value === 'recovery-callback-unconfigured' || value === 'recovery-timeout';
}

function isAgentChannelProviderHealthResultConsistent(
	health: AgentChannelProviderHealthKind,
	result: AgentVmHealthResultKind,
): boolean {
	switch (health) {
		case 'healthy':
		case 'transitioning':
			return result === 'ok';
		case 'unhealthy-recoverable':
		case 'unhealthy-unrecoverable':
			return result === 'failed';
	}
	return assertNeverAgentChannelProviderHealth(health);
}

function hasValidToolVmLeaseLifecycleFields(value: Record<string, unknown>): boolean {
	const hasLifecycleField =
		value.activeUseId !== undefined ||
		value.callerContextState !== undefined ||
		value.leaseRejectionReason !== undefined ||
		value.lifecycleEventRole !== undefined ||
		value.lifecycleTransition !== undefined ||
		value.oldLeaseId !== undefined ||
		value.replacementLeaseId !== undefined ||
		value.transitionId !== undefined;
	if (!hasLifecycleField) {
		return true;
	}
	if (
		!(
			optionalNonEmptyString(value.activeUseId) &&
			optionalOneOf(toolVmLeaseCallerContextStates, value.callerContextState) &&
			optionalOneOf(toolVmLeaseRejectionReasons, value.leaseRejectionReason) &&
			isOneOf(toolVmLeaseLifecycleEventRoles, value.lifecycleEventRole) &&
			isOneOf(toolVmLeaseLifecycleTransitions, value.lifecycleTransition) &&
			typeof value.oldLeaseId === 'string' &&
			value.oldLeaseId.length > 0 &&
			typeof value.transitionId === 'string' &&
			value.transitionId.length > 0
		)
	) {
		return false;
	}
	if (isToolVmLeaseReacquiredTransition(value.lifecycleTransition)) {
		return typeof value.replacementLeaseId === 'string' && value.replacementLeaseId.length > 0;
	}
	return (
		value.replacementLeaseId === undefined &&
		optionalOneOf(toolVmLeaseLifecycleEventRoles, value.lifecycleEventRole) &&
		optionalOneOf(toolVmLeaseLifecycleTransitions, value.lifecycleTransition)
	);
}

const gatewayControlSessionReconnectEvidenceKeys = [
	'attemptCount',
	'firstObservedAtMs',
	'latestObservedAtMs',
	'nextRetryAtMs',
	'outcome',
	'reconnectPhase',
	'terminalReason',
	'windowState',
] as const;

function hasValidGatewayControlSessionReconnectEvidence(value: Record<string, unknown>): boolean {
	const hasReconnectEvidence = gatewayControlSessionReconnectEvidenceKeys.some(
		(key) => value[key] !== undefined,
	);
	if (!hasReconnectEvidence) {
		return true;
	}
	if (
		!isNonNegativeInteger(value.attemptCount) ||
		typeof value.bootId !== 'string' ||
		value.bootId.length === 0 ||
		!isNonNegativeInteger(value.firstObservedAtMs) ||
		!isNonNegativeInteger(value.latestObservedAtMs) ||
		value.latestObservedAtMs < value.firstObservedAtMs ||
		!isOneOf(gatewayControlSessionReconnectOutcomes, value.outcome) ||
		!isOneOf(gatewayControlSessionReconnectPhases, value.reconnectPhase)
	) {
		return false;
	}
	const isAcceptedPhase = isOneOf(
		['accepted', 'stabilizing', 'stable'] as const,
		value.reconnectPhase,
	);
	if ((isAcceptedPhase && value.result !== 'ok') || (!isAcceptedPhase && value.result === 'ok')) {
		return false;
	}
	if (value.windowState === 'open') {
		if (isAcceptedPhase || value.terminalReason !== undefined) {
			return false;
		}
		if (value.reconnectPhase === 'retry-scheduled') {
			return (
				isNonNegativeInteger(value.nextRetryAtMs) && value.nextRetryAtMs >= value.latestObservedAtMs
			);
		}
		return value.nextRetryAtMs === undefined;
	}
	if (
		value.windowState !== 'closed' ||
		value.nextRetryAtMs !== undefined ||
		!isOneOf(gatewayControlSessionReconnectTerminalReasons, value.terminalReason)
	) {
		return false;
	}
	return value.terminalReason === 'accepted'
		? isAcceptedPhase && value.outcome === 'accepted'
		: !isAcceptedPhase && value.outcome !== 'accepted';
}

export function isAgentVmHealthEvent(value: unknown): value is AgentVmHealthEvent {
	if (!isRecord(value) || !hasBaseEventFields(value)) {
		return false;
	}
	switch (value.kind) {
		case 'caller-context-rejection':
			return (
				isOneOf(
					[
						'lease_create',
						'lease_get',
						'lease_peek',
						'lease_reacquire',
						'lease_release',
						'lease_renew',
						'lease_use_end',
						'lease_use_heartbeat',
						'lease_use_start',
					] as const,
					value.operation,
				) &&
				isOneOf(
					[
						'caller_context_absent',
						'caller_context_session_mismatch',
						'caller_context_stale',
					] as const,
					value.reason,
				) &&
				value.result === 'failed'
			);
		case 'gateway-service-health':
			return (
				typeof value.path === 'string' &&
				value.path.length > 0 &&
				Number.isInteger(value.port) &&
				optionalStatusCode(value.statusCode)
			);
		case 'gateway-control-session':
			return (
				optionalString(value.bootId) &&
				optionalString(value.connectionId) &&
				value.domain === 'gateway_control' &&
				isNonNegativeFiniteNumber(value.elapsedMs) &&
				hasValidGatewayControlSessionReconnectEvidence(value) &&
				isOneOf(gatewayControlSessionHealthOperations, value.operation) &&
				typeof value.peerId === 'string' &&
				value.peerId.length > 0 &&
				optionalString(value.sessionId)
			);
		case 'controller-request':
			return (
				Number.isInteger(value.attempt) &&
				isNonNegativeFiniteNumber(value.elapsedMs) &&
				optionalString(value.errorCode) &&
				Number.isInteger(value.maxAttempts) &&
				isOneOf(genericControllerRequestEventOperations, value.operation) &&
				optionalStatusCode(value.statusCode)
			);
		case 'lease-renew':
			return (
				typeof value.agentId === 'string' &&
				isNonNegativeFiniteNumber(value.elapsedMs) &&
				optionalString(value.errorCode) &&
				typeof value.leaseId === 'string'
			);
		case 'lease-heartbeat':
			return (
				typeof value.agentId === 'string' &&
				isNonNegativeFiniteNumber(value.elapsedMs) &&
				optionalString(value.errorCode) &&
				typeof value.leaseId === 'string' &&
				typeof value.useId === 'string'
			);
		case 'tool-vm-ssh':
			return (
				typeof value.agentId === 'string' &&
				isNonNegativeFiniteNumber(value.elapsedMs) &&
				optionalString(value.errorCode) &&
				typeof value.leaseId === 'string' &&
				isOneOf(['command', 'file-bridge', 'finalize', 'probe'] as const, value.operation) &&
				hasValidToolVmLeaseLifecycleFields(value)
			);
		case 'gateway-plugin-health':
			return (
				isOneOf(gatewayTypeValues, value.gatewayService) &&
				isOneOf(['starting', 'ready', 'stopping', 'failed'] as const, value.state)
			);
		case 'agent-channel-provider-health':
			return (
				typeof value.channelProviderId === 'string' &&
				value.channelProviderId.length > 0 &&
				isOneOf(agentChannelProviderHealthKinds, value.health) &&
				isOneOf(agentVmHealthResultKinds, value.result) &&
				isAgentChannelProviderHealthResultConsistent(value.health, value.result) &&
				optionalNonNegativeInteger(value.transitionStartedAtMs) &&
				optionalNonNegativeInteger(value.unhealthySinceMs) &&
				isRedactedHealthDetails(value.details)
			);
		case 'gateway-recovery':
			if (
				!isOneOf(
					[
						'gateway-vm-cold-start',
						'gateway-vm-restart',
						'observe-only',
						'operator-required',
					] as const,
					value.action,
				) ||
				!isNonNegativeInteger(value.consecutiveFailures) ||
				!isPositiveInteger(value.cooldownMs) ||
				!isNonNegativeFiniteNumber(value.elapsedMs) ||
				!isOneOf(gatewayRecoveryHealthReasons, value.reason) ||
				!optionalString(value.operationId)
			) {
				return false;
			}
			if (value.result === 'ok') {
				if (value.action !== 'gateway-vm-cold-start' && value.action !== 'gateway-vm-restart') {
					return false;
				}
				const hasNewGatewayIdentity =
					isNonNegativeInteger(value.leaseReleaseFailureCount) &&
					typeof value.newBootedAt === 'string' &&
					isNonNegativeInteger(value.newHostPid) &&
					typeof value.newVmId === 'string' &&
					value.errorCode === undefined;
				if (!hasNewGatewayIdentity) {
					return false;
				}
				if (value.action === 'gateway-vm-cold-start') {
					return (
						value.oldBootedAt === undefined &&
						value.oldHostPid === undefined &&
						value.oldVmId === undefined
					);
				}
				return (
					typeof value.oldBootedAt === 'string' &&
					isNonNegativeInteger(value.oldHostPid) &&
					typeof value.oldVmId === 'string'
				);
			}
			if (value.result === 'failed') {
				if (
					typeof value.errorCode !== 'string' ||
					value.errorCode.length === 0 ||
					!optionalNonNegativeInteger(value.leaseReleaseFailureCount) ||
					value.newBootedAt !== undefined ||
					value.newHostPid !== undefined ||
					value.newVmId !== undefined ||
					!optionalString(value.operationId)
				) {
					return false;
				}
				if (value.action === 'gateway-vm-restart') {
					if (isGatewayRecoveryTimeoutErrorCode(value.errorCode)) {
						return (
							optionalString(value.oldBootedAt) &&
							optionalNonNegativeInteger(value.oldHostPid) &&
							optionalString(value.oldVmId)
						);
					}
					return (
						optionalString(value.oldBootedAt) &&
						optionalNonNegativeInteger(value.oldHostPid) &&
						typeof value.oldVmId === 'string' &&
						value.oldVmId.length > 0
					);
				}
				return (
					(value.action === 'gateway-vm-cold-start' ||
						value.action === 'observe-only' ||
						value.action === 'operator-required') &&
					value.oldBootedAt === undefined &&
					value.oldHostPid === undefined &&
					value.oldVmId === undefined
				);
			}
			return false;
		case 'gateway-recovery-suspended':
			return (
				isOneOf(
					[
						'gateway-vm-cold-start',
						'gateway-vm-restart',
						'observe-only',
						'operator-required',
					] as const,
					value.action,
				) &&
				isNonNegativeInteger(value.consecutiveFailedRecoveries) &&
				isNonNegativeInteger(value.consecutiveFailures) &&
				isPositiveInteger(value.cooldownMs) &&
				value.errorCode === 'max-failed-recoveries' &&
				isPositiveInteger(value.failedRecoveryResetMs) &&
				optionalString(value.operationId) &&
				isOneOf(gatewayRecoveryHealthReasons, value.reason) &&
				value.result === 'failed'
			);
		default:
			return false;
	}
}

export function healthEventBucketKey(event: AgentVmHealthEvent): string {
	switch (event.kind) {
		case 'caller-context-rejection':
			return `${event.zoneId}:${event.kind}:${event.operation}:${event.reason}`;
		case 'gateway-control-session':
			return `${event.zoneId}:${event.kind}`;
		case 'gateway-service-health':
			return `${event.zoneId}:${event.kind}`;
		case 'controller-request':
			return `${event.zoneId}:${event.kind}:${event.operation}`;
		case 'lease-heartbeat':
			return `${event.zoneId}:${event.kind}:${event.leaseId}:${event.useId}`;
		case 'lease-renew':
			return `${event.zoneId}:${event.kind}:${event.leaseId}`;
		case 'tool-vm-ssh':
			if (event.transitionId !== undefined) {
				return `${event.zoneId}:${event.kind}:lifecycle:${event.transitionId}`;
			}
			return `${event.zoneId}:${event.kind}:${event.leaseId}:${event.operation}`;
		case 'gateway-plugin-health':
			return `${event.zoneId}:${event.kind}:${event.gatewayService}`;
		case 'agent-channel-provider-health':
			return `${event.zoneId}:${event.kind}:${event.channelProviderId}`;
		case 'gateway-recovery':
			return `${event.zoneId}:${event.kind}:${event.action}`;
		case 'gateway-recovery-suspended':
			return `${event.zoneId}:${event.kind}:${event.action}`;
	}
	return assertNeverHealthEvent(event);
}

type HealthIssueBearingEvent = Exclude<
	AgentVmHealthEvent,
	{ readonly kind: 'caller-context-rejection' }
>;

function isHealthIssueBearingEvent(event: AgentVmHealthEvent): event is HealthIssueBearingEvent {
	return event.kind !== 'caller-context-rejection';
}

function failedIssueKindForEvent(event: HealthIssueBearingEvent): ZoneHealthIssueKind {
	switch (event.kind) {
		case 'gateway-service-health':
			return 'gateway-service-unhealthy';
		case 'gateway-control-session':
			return 'gateway-control-session-unhealthy';
		case 'controller-request':
			return 'controller-request-failing';
		case 'lease-heartbeat':
			return 'lease-heartbeat-failing';
		case 'lease-renew':
			return 'lease-renew-failing';
		case 'tool-vm-ssh':
			return 'tool-vm-ssh-failing';
		case 'gateway-plugin-health':
			return 'gateway-plugin-unhealthy';
		case 'agent-channel-provider-health':
			return 'agent-channel-provider-unhealthy';
		case 'gateway-recovery':
			return 'gateway-recovery-failed';
		case 'gateway-recovery-suspended':
			return 'gateway-recovery-suspended';
	}
	return assertNeverHealthEvent(event);
}

function assertNeverHealthEvent(event: never): never {
	throw new Error(`Unhandled health event kind: ${JSON.stringify(event)}`);
}

function assertNeverAgentChannelProviderHealth(health: never): never {
	throw new Error(`Unhandled agent channel provider health: ${String(health)}`);
}

function issueForEvent(
	event: AgentVmHealthEvent,
	options: DeriveZoneHealthSnapshotOptions,
): ZoneHealthIssue | undefined {
	if (!isHealthIssueBearingEvent(event)) {
		return undefined;
	}
	if (
		options.nowMs - event.observedAtMs > options.staleAfterMs &&
		!isNonStalingSuccessfulEvent(event)
	) {
		return {
			kind: 'health-event-stale',
			latestEvent: event,
			message: `${event.kind} health event is stale`,
			sinceMs: event.observedAtMs,
		};
	}
	if (event.result === 'failed' || event.result === 'timeout' || event.result === 'stale') {
		return {
			kind: failedIssueKindForEvent(event),
			latestEvent: event,
			message: `${event.kind} health event reported ${event.result}`,
			sinceMs: event.observedAtMs,
		};
	}
	return undefined;
}

function isNonStalingSuccessfulEvent(event: AgentVmHealthEvent): boolean {
	return event.kind === 'gateway-recovery' && event.result === 'ok';
}

type ReacquiredControllerFinalToolVmSshEvent = Extract<
	AgentVmHealthEvent,
	{ readonly kind: 'tool-vm-ssh' }
> & {
	readonly lifecycleEventRole: 'controller_final';
	readonly lifecycleTransition: ToolVmLeaseReacquiredLifecycleTransition;
	readonly oldLeaseId: string;
	readonly replacementLeaseId: string;
	readonly transitionId: string;
};

function isReacquiredControllerFinalEvent(
	event: AgentVmHealthEvent,
): event is ReacquiredControllerFinalToolVmSshEvent {
	return (
		event.kind === 'tool-vm-ssh' &&
		event.lifecycleEventRole === 'controller_final' &&
		isToolVmLeaseReacquiredTransition(event.lifecycleTransition) &&
		event.result === 'ok'
	);
}

function latestReacquiredAtMsByOldLeaseId(
	events: readonly AgentVmHealthEvent[],
): ReadonlyMap<string, number> {
	const latestByOldLeaseId = new Map<string, number>();
	for (const event of events) {
		if (!isReacquiredControllerFinalEvent(event)) {
			continue;
		}
		const previousObservedAtMs = latestByOldLeaseId.get(event.oldLeaseId);
		if (previousObservedAtMs === undefined || previousObservedAtMs < event.observedAtMs) {
			latestByOldLeaseId.set(event.oldLeaseId, event.observedAtMs);
		}
	}
	return latestByOldLeaseId;
}

function isPlainToolVmSshEvent(
	event: AgentVmHealthEvent,
): event is Extract<AgentVmHealthEvent, { readonly kind: 'tool-vm-ssh' }> {
	return event.kind === 'tool-vm-ssh' && event.transitionId === undefined;
}

function filterSupersededToolVmSshEvents(
	events: readonly AgentVmHealthEvent[],
): readonly AgentVmHealthEvent[] {
	const latestReacquiredAtByOldLeaseId = latestReacquiredAtMsByOldLeaseId(events);
	return events.filter((event) => {
		if (!isPlainToolVmSshEvent(event)) {
			return true;
		}
		const reacquiredAtMs = latestReacquiredAtByOldLeaseId.get(event.leaseId);
		return reacquiredAtMs === undefined || reacquiredAtMs < event.observedAtMs;
	});
}

export function deriveZoneHealthSnapshot(
	events: readonly AgentVmHealthEvent[],
	options: DeriveZoneHealthSnapshotOptions,
): ZoneHealthSnapshot {
	const latestByKey = new Map<string, AgentVmHealthEvent>();
	for (const event of events) {
		if (event.zoneId !== options.zoneId || event.kind === 'caller-context-rejection') {
			continue;
		}
		const key = healthEventBucketKey(event);
		const previous = latestByKey.get(key);
		if (!previous || previous.observedAtMs <= event.observedAtMs) {
			latestByKey.set(key, event);
		}
	}
	const latestEvents = filterSupersededToolVmSshEvents([...latestByKey.values()]).toSorted(
		(first, second) => second.observedAtMs - first.observedAtMs,
	);
	if (latestEvents.length === 0) {
		return { kind: 'unknown', reason: 'no-events', zoneId: options.zoneId };
	}
	const issues = latestEvents
		.map((event) => issueForEvent(event, options))
		.filter((issue): issue is ZoneHealthIssue => issue !== undefined);
	if (issues.length === 0) {
		return { kind: 'ok', latestEvents, zoneId: options.zoneId };
	}
	if (issues.some((issue) => issue.kind === 'health-event-stale')) {
		return { issues, kind: 'stale', latestEvents, zoneId: options.zoneId };
	}
	return { issues, kind: 'failed', latestEvents, zoneId: options.zoneId };
}
