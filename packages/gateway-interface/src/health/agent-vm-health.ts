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

export type AgentVmHealthEvent =
	| (AgentVmHealthEventBase & {
			readonly kind: 'gateway-service-health';
			readonly path: string;
			readonly port: number;
			readonly statusCode?: number | undefined;
	  })
	| (AgentVmHealthEventBase & {
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
	  })
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

export function isAgentVmHealthEvent(value: unknown): value is AgentVmHealthEvent {
	if (!isRecord(value) || !hasBaseEventFields(value)) {
		return false;
	}
	switch (value.kind) {
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
				isOneOf(['command', 'file-bridge', 'finalize', 'probe'] as const, value.operation)
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

function failedIssueKindForEvent(event: AgentVmHealthEvent): ZoneHealthIssueKind {
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

export function deriveZoneHealthSnapshot(
	events: readonly AgentVmHealthEvent[],
	options: DeriveZoneHealthSnapshotOptions,
): ZoneHealthSnapshot {
	const latestByKey = new Map<string, AgentVmHealthEvent>();
	for (const event of events) {
		if (event.zoneId !== options.zoneId) {
			continue;
		}
		const key = healthEventBucketKey(event);
		const previous = latestByKey.get(key);
		if (!previous || previous.observedAtMs <= event.observedAtMs) {
			latestByKey.set(key, event);
		}
	}
	const latestEvents = [...latestByKey.values()].toSorted(
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
