import type { AgentVmHealthEventKind } from '@agent-vm/gateway-interface';

import type { GatewayOwnershipEvidence } from '../../gateway/gateway-ownership-evidence.js';
import type { ControllerZoneLifecycleState } from '../../operations/controller-status.js';
import type { GatewayVmRecoveryReason } from '../health/gateway-vm-recovery-policy.js';
import type { GatewayZoneRuntimeHandle } from './zone-runtime-types.js';

export type GatewayLifecycleErrorCode =
	| 'secret-resolution-failed'
	| 'image-build-failed'
	| 'vm-create-failed'
	| 'vm-start-failed'
	| 'readiness-failed'
	| 'record-write-failed'
	| 'old-gateway-not-running'
	| 'vm-process-missing'
	| 'gateway-control-link-unhealthy'
	| 'gateway-service-unhealthy'
	| 'agent-channel-provider-unhealthy'
	| 'owner-unsafe'
	| 'recovery-timeout'
	| 'stale-generation-closed';

export type GatewayRecoveryErrorCode = Extract<GatewayLifecycleErrorCode, GatewayVmRecoveryReason>;

export interface GatewayLifecycleErrorSnapshot {
	readonly code: GatewayLifecycleErrorCode;
	readonly message: string;
}

export type GatewayZoneLifecycleState =
	| { readonly kind: 'stopped' }
	| { readonly kind: 'starting'; readonly operationId: string; readonly startedAtMs: number }
	| { readonly kind: 'running'; readonly gateway: GatewayZoneRuntimeHandle }
	| {
			readonly gateway: GatewayZoneRuntimeHandle;
			readonly kind: 'running-degraded';
			readonly reason: GatewayVmRecoveryReason;
	  }
	| {
			readonly kind: 'stopping';
			readonly next: 'stopped' | 'starting';
			readonly operationId: string;
			readonly previousGateway: GatewayZoneRuntimeHandle | undefined;
	  }
	| {
			readonly kind: 'restarting';
			readonly operationId: string;
			readonly previousGateway: GatewayZoneRuntimeHandle;
	  }
	| {
			readonly coldStartEligible: boolean;
			readonly error: GatewayLifecycleErrorSnapshot;
			readonly kind: 'failed';
	  }
	| { readonly evidence: GatewayOwnershipEvidence; readonly kind: 'owner-unsafe' };

export type GatewaySelectedZoneReadiness = 'running' | 'degraded' | 'failed' | 'owner-unsafe';

export type GatewayChannelProviderPlane =
	| 'ok'
	| 'transitioning'
	| 'degraded'
	| 'failed'
	| 'unknown';

export type GatewayToolVmPlane = 'ok' | 'degraded' | 'failed' | 'unknown';
export type GatewayToolVmLeaseState = 'none' | 'idle' | 'active' | 'expired' | 'not-applicable';

export type GatewayLifecycleOperation =
	| 'start'
	| 'stop'
	| 'restart'
	| 'cold-start'
	| 'credentials-refresh'
	| 'none';

export type GatewayOutageEvidenceEventKind = AgentVmHealthEventKind | 'gateway-lifecycle-operation';

export interface GatewayDiagnosisSnapshot {
	readonly channelProviderPlane: GatewayChannelProviderPlane;
	readonly controllerLiveness: 'ok' | 'failed';
	readonly currentRecoveryBlocker: GatewayLifecycleErrorCode | 'none';
	readonly gatewayInfrastructure: GatewayZoneLifecycleState['kind'];
	readonly lastOperation: GatewayLifecycleOperation;
	readonly originalOutageCause:
		| { readonly kind: 'unknown' }
		| {
				readonly errorCode?: GatewayLifecycleErrorCode;
				readonly eventKind: GatewayOutageEvidenceEventKind;
				readonly kind: 'proven';
		  };
	readonly selectedZoneReadiness: GatewaySelectedZoneReadiness;
	readonly toolVmLeaseState: GatewayToolVmLeaseState;
	readonly toolVmPlane: GatewayToolVmPlane;
}

export interface DeriveGatewayDiagnosisSnapshotInput {
	readonly channelProviderPlane: GatewayChannelProviderPlane;
	readonly controllerLiveness: 'ok' | 'failed';
	readonly lastOperation?: GatewayLifecycleOperation | undefined;
	readonly originalOutageCause?: GatewayDiagnosisSnapshot['originalOutageCause'] | undefined;
	readonly state: GatewayZoneLifecycleState;
	readonly toolVmLeaseState?: GatewayToolVmLeaseState | undefined;
	readonly toolVmPlane: GatewayToolVmPlane;
}

export type GatewayZoneLifecycleEvent =
	| { readonly kind: 'start-requested'; readonly operationId: string; readonly startedAtMs: number }
	| { readonly kind: 'gateway-started'; readonly gateway: GatewayZoneRuntimeHandle }
	| {
			readonly coldStartEligible: boolean;
			readonly error: GatewayLifecycleErrorSnapshot;
			readonly kind: 'start-failed';
	  }
	| { readonly kind: 'stop-requested'; readonly operationId: string }
	| { readonly kind: 'stopped' }
	| { readonly evidence: GatewayOwnershipEvidence; readonly kind: 'owner-unsafe' };

export function projectGatewayZoneLifecycleStateForStatus(
	state: GatewayZoneLifecycleState,
): ControllerZoneLifecycleState {
	switch (state.kind) {
		case 'running':
		case 'running-degraded':
			return 'running';
		case 'failed':
		case 'owner-unsafe':
			return 'failed';
		case 'restarting':
		case 'starting':
		case 'stopped':
		case 'stopping':
			return 'stopped';
	}
	return assertNeverGatewayZoneLifecycleState(state);
}

export function transitionGatewayZoneState(
	state: GatewayZoneLifecycleState,
	event: GatewayZoneLifecycleEvent,
): GatewayZoneLifecycleState {
	switch (event.kind) {
		case 'start-requested':
			return {
				kind: 'starting',
				operationId: event.operationId,
				startedAtMs: event.startedAtMs,
			};
		case 'gateway-started':
			return { gateway: event.gateway, kind: 'running' };
		case 'start-failed':
			return {
				coldStartEligible: event.coldStartEligible,
				error: event.error,
				kind: 'failed',
			};
		case 'stop-requested':
			return {
				kind: 'stopping',
				next: 'stopped',
				operationId: event.operationId,
				previousGateway:
					state.kind === 'running' || state.kind === 'running-degraded' ? state.gateway : undefined,
			};
		case 'stopped':
			return { kind: 'stopped' };
		case 'owner-unsafe':
			return { evidence: event.evidence, kind: 'owner-unsafe' };
	}
	return assertNeverGatewayZoneLifecycleEvent(event);
}

export function classifyGatewayStartError(error: unknown): GatewayLifecycleErrorSnapshot {
	const message = getErrorMessage(error);
	const normalizedMessage = message.toLowerCase();
	if (
		normalizedMessage.includes('secret') ||
		normalizedMessage.includes('resolveall') ||
		normalizedMessage.includes('op://') ||
		normalizedMessage.includes('1password')
	) {
		return { code: 'secret-resolution-failed', message };
	}
	if (normalizedMessage.includes('image') || normalizedMessage.includes('build')) {
		return { code: 'image-build-failed', message };
	}
	if (normalizedMessage.includes('readyz') || normalizedMessage.includes('readiness')) {
		return { code: 'readiness-failed', message };
	}
	if (normalizedMessage.includes('stale-generation-closed')) {
		return { code: 'stale-generation-closed', message };
	}
	return { code: 'vm-start-failed', message };
}

export function classifyGatewayRecoveryPrecondition(
	state: GatewayZoneLifecycleState,
	ownership:
		| { readonly kind: 'clear' }
		| { readonly evidence: GatewayOwnershipEvidence; readonly kind: 'blocked' },
): GatewayLifecycleErrorSnapshot | null {
	if (ownership.kind === 'blocked') {
		return {
			code: 'owner-unsafe',
			message: `Gateway recovery is blocked by unsafe ownership evidence: ${ownership.evidence.kind}.`,
		};
	}
	if (state.kind === 'running' || state.kind === 'running-degraded') {
		return null;
	}
	if (state.kind === 'failed') {
		return state.error;
	}
	return {
		code: 'old-gateway-not-running',
		message: `Gateway recovery cannot restart a gateway in '${state.kind}' state without cold-start.`,
	};
}

export function deriveGatewayDiagnosisSnapshot(
	input: DeriveGatewayDiagnosisSnapshotInput,
): GatewayDiagnosisSnapshot {
	return {
		channelProviderPlane: input.channelProviderPlane,
		controllerLiveness: input.controllerLiveness,
		currentRecoveryBlocker: currentRecoveryBlockerForState(input.state),
		gatewayInfrastructure: input.state.kind,
		lastOperation: input.lastOperation ?? 'none',
		originalOutageCause: input.originalOutageCause ?? { kind: 'unknown' },
		selectedZoneReadiness: selectedZoneReadinessForState(input.state),
		toolVmLeaseState: input.toolVmLeaseState ?? 'not-applicable',
		toolVmPlane: input.toolVmPlane,
	};
}

function currentRecoveryBlockerForState(
	state: GatewayZoneLifecycleState,
): GatewayLifecycleErrorCode | 'none' {
	switch (state.kind) {
		case 'failed':
			return state.error.code;
		case 'owner-unsafe':
			return 'owner-unsafe';
		case 'running-degraded':
			return state.reason;
		case 'restarting':
		case 'running':
		case 'starting':
		case 'stopped':
		case 'stopping':
			return 'none';
	}
	return assertNeverGatewayZoneLifecycleState(state);
}

function selectedZoneReadinessForState(
	state: GatewayZoneLifecycleState,
): GatewaySelectedZoneReadiness {
	switch (state.kind) {
		case 'running':
			return 'running';
		case 'restarting':
		case 'running-degraded':
		case 'starting':
		case 'stopping':
			return 'degraded';
		case 'failed':
		case 'stopped':
			return 'failed';
		case 'owner-unsafe':
			return 'owner-unsafe';
	}
	return assertNeverGatewayZoneLifecycleState(state);
}

function assertNeverGatewayZoneLifecycleState(state: never): never {
	throw new Error(`Unhandled gateway zone lifecycle state: ${JSON.stringify(state)}`);
}

function assertNeverGatewayZoneLifecycleEvent(event: never): never {
	throw new Error(`Unhandled gateway zone lifecycle event: ${JSON.stringify(event)}`);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}
	if (typeof error === 'string' && error.length > 0) {
		return error;
	}
	return 'Unknown gateway start failure.';
}
