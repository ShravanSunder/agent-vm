import { gatewayTypeValues, type GatewayType } from '../gateway-runtime-contract.js';
import {
	genericControllerRequestEventOperations,
	type GenericControllerRequestEventOperation,
} from './controller-request-policy.js';

export const agentVmHealthEventKinds = [
	'gateway-service-health',
	'gateway-control-link',
	'controller-request',
	'lease-renew',
	'lease-heartbeat',
	'tool-vm-ssh',
	'gateway-plugin-health',
	'gateway-recovery',
] as const;

export type AgentVmHealthEventKind = (typeof agentVmHealthEventKinds)[number];

export const agentVmHealthResultKinds = ['ok', 'failed', 'timeout', 'stale'] as const;

export type AgentVmHealthResultKind = (typeof agentVmHealthResultKinds)[number];

export interface AgentVmHealthEventBase {
	readonly observedAtMs: number;
	readonly result: AgentVmHealthResultKind;
	readonly zoneId: string;
}

export type ToolVmSshHealthOperation = 'command' | 'file-bridge' | 'finalize' | 'probe';

export type GatewayRecoveryHealthReason =
	| 'gateway-control-link-unhealthy'
	| 'gateway-service-unhealthy';

export const gatewayControlLinkHealthPins = {
	controllerHost: 'controller.vm.host',
	controllerPort: 18800,
	operation: 'controller-health',
	path: '/health',
} as const;

export type AgentVmHealthEvent =
	| (AgentVmHealthEventBase & {
			readonly kind: 'gateway-service-health';
			readonly path: string;
			readonly port: number;
			readonly statusCode?: number | undefined;
	  })
	| (AgentVmHealthEventBase & {
			readonly controllerHost: typeof gatewayControlLinkHealthPins.controllerHost;
			readonly controllerPort: typeof gatewayControlLinkHealthPins.controllerPort;
			readonly elapsedMs: number;
			readonly kind: 'gateway-control-link';
			readonly operation: typeof gatewayControlLinkHealthPins.operation;
			readonly path: typeof gatewayControlLinkHealthPins.path;
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
			readonly action: 'gateway-vm-restart';
			readonly consecutiveFailures: number;
			readonly cooldownMs: number;
			readonly elapsedMs: number;
			readonly errorCode?: string | undefined;
			readonly kind: 'gateway-recovery';
			readonly leaseReleaseFailureCount?: number | undefined;
			readonly newBootedAt?: string | undefined;
			readonly newHostPid?: number | undefined;
			readonly newVmId?: string | undefined;
			readonly oldBootedAt?: string | undefined;
			readonly oldHostPid?: number | undefined;
			readonly oldVmId?: string | undefined;
			readonly reason: GatewayRecoveryHealthReason;
			readonly result: 'failed' | 'ok';
	  });

export const zoneHealthStateKinds = ['unknown', 'ok', 'stale', 'failed'] as const;

export type ZoneHealthStateKind = (typeof zoneHealthStateKinds)[number];

export const zoneHealthIssueKinds = [
	'gateway-service-unhealthy',
	'gateway-control-link-unhealthy',
	'controller-request-failing',
	'lease-heartbeat-failing',
	'lease-renew-failing',
	'tool-vm-ssh-failing',
	'gateway-plugin-unhealthy',
	'gateway-recovery-failed',
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
		case 'gateway-control-link':
			return (
				value.controllerHost === gatewayControlLinkHealthPins.controllerHost &&
				value.controllerPort === gatewayControlLinkHealthPins.controllerPort &&
				isNonNegativeFiniteNumber(value.elapsedMs) &&
				value.operation === gatewayControlLinkHealthPins.operation &&
				value.path === gatewayControlLinkHealthPins.path
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
		case 'gateway-recovery':
			return (
				value.action === 'gateway-vm-restart' &&
				isNonNegativeInteger(value.consecutiveFailures) &&
				isPositiveInteger(value.cooldownMs) &&
				isNonNegativeFiniteNumber(value.elapsedMs) &&
				optionalString(value.errorCode) &&
				optionalNonNegativeInteger(value.leaseReleaseFailureCount) &&
				optionalString(value.newBootedAt) &&
				optionalNonNegativeInteger(value.newHostPid) &&
				optionalString(value.newVmId) &&
				optionalString(value.oldBootedAt) &&
				optionalNonNegativeInteger(value.oldHostPid) &&
				optionalString(value.oldVmId) &&
				isOneOf(
					['gateway-control-link-unhealthy', 'gateway-service-unhealthy'] as const,
					value.reason,
				)
			);
		default:
			return false;
	}
}

export function healthEventBucketKey(event: AgentVmHealthEvent): string {
	switch (event.kind) {
		case 'gateway-control-link':
			return `${event.zoneId}:${event.kind}`;
		case 'gateway-service-health':
			return `${event.zoneId}:${event.kind}:${event.port}:${event.path}`;
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
		case 'gateway-recovery':
			return `${event.zoneId}:${event.kind}:${event.action}`;
	}
	return assertNeverHealthEvent(event);
}

function failedIssueKindForEvent(event: AgentVmHealthEvent): ZoneHealthIssueKind {
	switch (event.kind) {
		case 'gateway-service-health':
			return 'gateway-service-unhealthy';
		case 'gateway-control-link':
			return 'gateway-control-link-unhealthy';
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
		case 'gateway-recovery':
			return 'gateway-recovery-failed';
	}
	return assertNeverHealthEvent(event);
}

function assertNeverHealthEvent(event: never): never {
	throw new Error(`Unhandled health event kind: ${JSON.stringify(event)}`);
}

function issueForEvent(
	event: AgentVmHealthEvent,
	options: DeriveZoneHealthSnapshotOptions,
): ZoneHealthIssue | undefined {
	if (options.nowMs - event.observedAtMs > options.staleAfterMs) {
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
