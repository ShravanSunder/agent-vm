import type { GatewayApprovalDecisionResult } from '@agent-vm/agent-portal-sdk';
import type { ControlEnvelope } from '@agent-vm/control-protocol-contracts';
import {
	type GatewayControlLeaseCreateIntentPayload,
	type GatewayControlLeaseIdPayload,
	type GatewayControlLeaseReacquireIntentPayload,
	type GatewayControlLeaseRejectionReason,
	type GatewayControlLeaseSnapshot,
	type GatewayControlLeaseUseEndPayload,
	type GatewayControlLeaseUseHeartbeatPayload,
	type GatewayControlLeaseUseSnapshot,
	type GatewayControlLeaseUseStartPayload,
	type GatewayControlHealthEventPayload,
	type GatewayControlProviderRuntimeHealth,
	type GatewayControlRuntimeStatusPayload,
	type GatewayControlControllerHostProbeResult,
	type GatewayControlToolPortalControllerExecutionPayload,
	type GatewayControlToolPortalControllerExecutionResult,
	type GatewayControlToolVmBindingPublicationAuthority,
	type GatewayControlToolVmBindingRequestResult,
	type GatewayControlRpcMessage,
	type GatewayControlWorkspaceGitPushResult,
	type GatewayRuntimeApprovalAdmissionResult,
	type GatewayRuntimeApprovalArmDispatchResult,
	GatewayRuntimeApprovalArmDispatchResultSchema,
	type GatewayRuntimeApprovalAuthorityContext,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeApprovalDispatchReservation,
	type GatewayRuntimeReadinessSnapshot,
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlLeaseSnapshotSchema,
	GatewayControlLeaseRejectionReasonSchema,
	GatewayControlLeaseUseSnapshotSchema,
	GatewayControlRpcMessageSchema,
	GatewayControlRpcResponsePayloadSchema,
	assertGatewayControlEnvelopeDeliveryPolicy,
	deriveGatewayControlStablePrincipal,
	gatewayControlDeliveryPolicyByKind,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import {
	normalizeToolVmActiveUseCorrelation,
	type AgentVmHealthEvent,
} from '@agent-vm/gateway-lifecycle';

import type {
	ControllerApprovalArmDispatchResult,
	ControllerApprovalDecisionResult,
	ControllerApprovalOperatorIdentity,
} from '../approval/controller-approval-ledger.js';
import type { OpenClawRuntimeStatusReport } from '../openclaw-runtime-status.js';
import { ConfiguredControllerExecutionError } from '../runner/configured-controller-execution-error.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { WorkspaceGitPushRejectedError } from '../workspace-git/workspace-git-operations.js';
import type { ControlSessionDomainHandler } from './control-session-dispatcher.js';
import type { GatewayControlBindingPublicationCoordinator } from './gateway-control-binding-publication.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlCallerContextSessionRef,
	GatewayControlCallerContextRegistry,
	GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';
import {
	parseGatewaySemanticJsonValue,
	type GatewaySemanticExecutionProof,
	type GatewaySemanticGenerationProfile,
} from './gateway-semantic-result-ledger.js';

export type GatewayControlLeaseSemanticMutationOperation =
	| 'lease_create'
	| 'lease_reacquire'
	| 'lease_release'
	| 'lease_renew'
	| 'lease_use_end'
	| 'lease_use_heartbeat'
	| 'lease_use_start';

type GatewayControlLeaseSemanticMutationMessage = Extract<
	GatewayControlRpcMessage,
	{
		readonly kind: 'command';
		readonly operation: GatewayControlLeaseSemanticMutationOperation;
	}
>;

export type GatewayControlLeaseSemanticMutationPayload =
	| GatewayControlLeaseCreateIntentPayload
	| GatewayControlLeaseIdPayload
	| GatewayControlLeaseReacquireIntentPayload
	| GatewayControlLeaseUseEndPayload
	| GatewayControlLeaseUseHeartbeatPayload
	| GatewayControlLeaseUseStartPayload;

type GatewayControlLeaseSemanticMutationPreparationBase = {
	readonly attachmentGeneration: number;
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly gateway: GatewayEpochIdentity;
	readonly processEpoch: string;
};

export type GatewayControlLeaseSemanticMutationPreparationOptions =
	GatewayControlLeaseSemanticMutationPreparationBase &
		(
			| {
					readonly operation: 'lease_create';
					readonly payload: GatewayControlLeaseCreateIntentPayload;
			  }
			| {
					readonly operation: 'lease_reacquire';
					readonly payload: GatewayControlLeaseReacquireIntentPayload;
			  }
			| {
					readonly operation: 'lease_release' | 'lease_renew';
					readonly payload: GatewayControlLeaseIdPayload;
			  }
			| {
					readonly operation: 'lease_use_end';
					readonly payload: GatewayControlLeaseUseEndPayload;
			  }
			| {
					readonly operation: 'lease_use_heartbeat';
					readonly payload: GatewayControlLeaseUseHeartbeatPayload;
			  }
			| {
					readonly operation: 'lease_use_start';
					readonly payload: GatewayControlLeaseUseStartPayload;
			  }
		);

export type GatewayControlLeaseSemanticMutationResult =
	| GatewayControlLeaseRpcRejection
	| GatewayControlLeaseSnapshot
	| GatewayControlLeaseUseSnapshot
	| undefined;

export interface GatewayControlPreparedLeaseSemanticMutation {
	readonly execute: (
		proof: GatewaySemanticExecutionProof,
	) => Promise<GatewayControlLeaseSemanticMutationResult>;
	readonly profile: GatewaySemanticGenerationProfile;
	readonly target: string;
}

export interface GatewayControlLeaseRpcOperations {
	readonly getLease: (
		request: {
			readonly callerContext: GatewayControlTrustedCallerContext | undefined;
			readonly gateway: GatewayEpochIdentity;
			readonly payload: GatewayControlLeaseIdPayload;
		},
		readOptions: { readonly includeSsh: 'private' | 'public' | false },
	) => Promise<GatewayControlLeaseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
	readonly prepareSemanticMutation: (
		options: GatewayControlLeaseSemanticMutationPreparationOptions,
	) => Promise<GatewayControlPreparedLeaseSemanticMutation>;
}

export interface GatewayControlLeaseRpcRejection {
	readonly leaseRejectionReason: GatewayControlLeaseRejectionReason;
	readonly result: 'rejected';
}

export interface GatewayControlControllerExecutionOperations {
	authorizeControllerExecution(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly createdAtMs: number;
		readonly expiresAtMs: number | undefined;
		readonly payload: GatewayControlToolPortalControllerExecutionPayload;
		readonly session: GatewayControlAcceptedSessionRef;
	}): Promise<
		| {
				readonly authorized: true;
		  }
		| {
				readonly authorized: false;
				readonly errorClass: string;
				readonly safeMessage: string;
		  }
	>;
	executeConfiguredCli(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: Extract<
			GatewayControlToolPortalControllerExecutionPayload,
			{ readonly kind: 'configured_cli' }
		>;
		readonly signal: AbortSignal;
		readonly session: GatewayControlAcceptedSessionRef;
	}): Promise<
		Extract<
			GatewayControlToolPortalControllerExecutionResult,
			{ readonly kind: 'configured_cli' }
		>['result']
	>;
	pushWorkspaceGit(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: Extract<
			Extract<
				GatewayControlToolPortalControllerExecutionPayload,
				{ readonly kind: 'registered_action' }
			>['action'],
			{ readonly actionId: 'workspace_git_push' }
		>;
		readonly session: GatewayControlAcceptedSessionRef;
	}): Promise<GatewayControlWorkspaceGitPushResult>;
	runControllerHostProbe(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: Extract<
			Extract<
				GatewayControlToolPortalControllerExecutionPayload,
				{ readonly kind: 'registered_action' }
			>['action'],
			{ readonly actionId: 'controller_host_probe' }
		>;
		readonly session: GatewayControlAcceptedSessionRef;
	}): Promise<GatewayControlControllerHostProbeResult>;
}

export interface GatewayControlDomainHandlerOptions {
	readonly approvalLedger?: GatewayControlApprovalLedgerOperations;
	readonly callerContexts: GatewayControlCallerContextRegistry;
	readonly bindingPublication?: GatewayControlBindingPublicationCoordinator;
	readonly controllerExecutions?: GatewayControlControllerExecutionOperations;
	readonly gateway: GatewayEpochIdentity;
	readonly leaseRpc?: GatewayControlLeaseRpcOperations;
	readonly managedApprovalAuthority?: { readonly approverId: string };
	readonly now?: () => number;
	readonly recordGatewayRuntimeReadiness?: (snapshot: GatewayRuntimeReadinessSnapshot) => void;
	readonly recordHealthEvent?: (event: AgentVmHealthEvent) => void;
	readonly recordRuntimeStatus?: (report: OpenClawRuntimeStatusReport) => void;
	readonly session: GatewayControlAcceptedSessionRef;
}

type CommandDeadlineResult<TResult> =
	| { readonly kind: 'completed'; readonly value: TResult }
	| { readonly kind: 'expired' };

async function settleCommandWorkAtExpiry<TResult>(options: {
	readonly expiresAtMs: number;
	readonly now: () => number;
	readonly work: Promise<TResult>;
}): Promise<CommandDeadlineResult<TResult>> {
	const remainingMilliseconds = options.expiresAtMs - options.now();
	if (remainingMilliseconds <= 0) return { kind: 'expired' };
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<{ readonly kind: 'expired' }>((resolve) => {
		expiryTimer = setTimeout(() => resolve({ kind: 'expired' }), remainingMilliseconds);
	});
	try {
		return await Promise.race([
			options.work.then((value) => ({ kind: 'completed', value }) as const),
			expiry,
		]);
	} finally {
		if (expiryTimer !== undefined) clearTimeout(expiryTimer);
	}
}

export interface GatewayControlApprovalLedgerOperations {
	readonly armDispatch: (props: {
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly reservation: GatewayRuntimeApprovalDispatchReservation;
	}) => Promise<ControllerApprovalArmDispatchResult>;
	readonly decide: (props: {
		readonly approvalId: string;
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly decision: 'approve' | 'deny';
		readonly operator: ControllerApprovalOperatorIdentity;
	}) => Promise<ControllerApprovalDecisionResult>;
	readonly requestApproval: (props: {
		readonly authorityContext: GatewayRuntimeApprovalAuthorityContext;
		readonly intent: GatewayRuntimeApprovalChallengeIntent;
	}) => Promise<GatewayRuntimeApprovalAdmissionResult>;
}

type CommandResultKind =
	| 'approval_required'
	| 'approval_stale'
	| 'cancelled'
	| 'failed'
	| 'ok'
	| 'rejected'
	| 'timeout';

type GatewayControlCommandResultPayload = Extract<
	GatewayControlRpcMessage,
	{ readonly kind: 'command_result' }
>['payload'];

function assertLeaseRpcConfigured(
	leaseRpc: GatewayControlLeaseRpcOperations | undefined,
): GatewayControlLeaseRpcOperations {
	if (leaseRpc === undefined) {
		throw new Error('gateway control lease RPC operations are not configured');
	}
	return leaseRpc;
}

function assertBindingPublicationConfigured(
	bindingPublication: GatewayControlBindingPublicationCoordinator | undefined,
): GatewayControlBindingPublicationCoordinator {
	if (bindingPublication === undefined) {
		throw new Error('gateway control binding publication coordinator is not configured');
	}
	return bindingPublication;
}

function bindingPublicationAuthorityFromEnvelope(options: {
	readonly attachmentGeneration: number | undefined;
	readonly envelope: ControlEnvelope;
	readonly gateway: GatewayEpochIdentity;
}): GatewayControlToolVmBindingPublicationAuthority {
	if (options.attachmentGeneration === undefined) {
		throw new Error('gateway Tool VM binding request is missing attachment generation');
	}
	return {
		attachmentGeneration: options.attachmentGeneration,
		connectionId: options.envelope.connectionId,
		controllerEpoch: options.envelope.controllerEpoch,
		gatewayEpoch: options.gateway.generationId,
		processEpoch: options.envelope.bootId,
		sessionId: options.envelope.sessionId,
		zoneId: options.envelope.zoneId,
	};
}

function callerContextSessionFromEnvelope(
	envelope: ControlEnvelope,
): GatewayControlCallerContextSessionRef {
	return {
		bootId: envelope.bootId,
		connectionId: envelope.connectionId,
		controllerEpoch: envelope.controllerEpoch,
		peerId: envelope.peerId,
		sessionId: envelope.sessionId,
		zoneId: envelope.zoneId,
	};
}

type CallerContextRejectionHealthEvent = Extract<
	AgentVmHealthEvent,
	{ readonly kind: 'caller-context-rejection' }
>;

export type GatewayControlInboundPrincipalResolution =
	| {
			readonly stablePrincipal: string;
			readonly status: 'accepted';
	  }
	| {
			readonly leaseRejectionReason: CallerContextRejectionHealthEvent['reason'];
			readonly operation: CallerContextRejectionHealthEvent['operation'];
			readonly status: 'lease_rejected';
	  }
	| {
			readonly operation:
				| 'tool_portal_approval_decide'
				| 'tool_portal_controller_execution'
				| 'tool_vm_binding_request';
			readonly reason:
				| 'caller_context_absent'
				| 'caller_context_session_mismatch'
				| 'caller_context_stale';
			readonly status: 'principal_rejected';
	  }
	| { readonly status: 'not_required' };

function leaseCallerContextRejection(options: {
	readonly operation: CallerContextRejectionHealthEvent['operation'];
	readonly reason:
		| 'caller_context_absent'
		| 'caller_context_session_mismatch'
		| 'caller_context_stale';
}): GatewayControlInboundPrincipalResolution {
	return {
		leaseRejectionReason: options.reason,
		operation: options.operation,
		status: 'lease_rejected',
	};
}

export function resolveGatewayControlInboundStablePrincipal(options: {
	readonly callerContexts: GatewayControlCallerContextRegistry;
	readonly envelope: ControlEnvelope;
	readonly message: GatewayControlRpcMessage;
}): GatewayControlInboundPrincipalResolution {
	if (options.message.kind !== 'command') {
		return { status: 'not_required' };
	}
	const session = callerContextSessionFromEnvelope(options.envelope);
	if (options.message.operation === 'caller_context_register') {
		return {
			stablePrincipal: options.callerContexts.validateRegistrationForSession({
				payload: options.message.payload,
				session,
			}).stablePrincipal,
			status: 'accepted',
		};
	}
	let callerContextId: string | undefined;
	switch (options.message.operation) {
		case 'lease_create':
		case 'lease_reacquire':
		case 'lease_release':
		case 'lease_renew':
		case 'lease_use_end':
		case 'lease_use_heartbeat':
		case 'lease_use_start':
		case 'tool_vm_binding_request':
			callerContextId = options.message.payload.callerContext.callerContextId;
			break;
		case 'tool_portal_controller_execution':
			callerContextId = controllerExecutionCallerContextRef(
				options.message.payload,
			).callerContextId;
			break;
		case 'tool_portal_approval_decide':
			callerContextId = options.message.payload.callerContext.callerContextId;
			break;
		case 'lease_get':
		case 'lease_peek':
			callerContextId = options.message.payload.callerContext?.callerContextId;
			break;
		case 'control_ping':
		case 'operation_cancel':
		case 'recovery_command':
		case 'tool_vm_binding_publish':
			return { status: 'not_required' };
		case 'tool_portal_admission_reserve':
			return {
				stablePrincipal: deriveGatewayControlStablePrincipal({
					principal: options.message.payload.intent.trustedContext.principal,
				}),
				status: 'accepted',
			};
		case 'tool_portal_dispatch_arm':
			return {
				stablePrincipal: options.message.payload.reservation.stablePrincipal,
				status: 'accepted',
			};
	}
	if (callerContextId === undefined) {
		if (options.message.operation === 'lease_get' || options.message.operation === 'lease_peek') {
			return leaseCallerContextRejection({
				operation: options.message.operation,
				reason: 'caller_context_absent',
			});
		}
		return {
			operation:
				options.message.operation === 'tool_vm_binding_request'
					? 'tool_vm_binding_request'
					: options.message.operation === 'tool_portal_approval_decide'
						? 'tool_portal_approval_decide'
						: 'tool_portal_controller_execution',
			reason: 'caller_context_absent',
			status: 'principal_rejected',
		};
	}
	const resolution = options.callerContexts.resolveForSession({ callerContextId, session });
	if (resolution.status === 'ok') {
		return {
			stablePrincipal: resolution.callerContext.stablePrincipal,
			status: 'accepted',
		};
	}
	const operation = options.message.operation;
	switch (operation) {
		case 'lease_create':
		case 'lease_get':
		case 'lease_peek':
		case 'lease_reacquire':
		case 'lease_release':
		case 'lease_renew':
		case 'lease_use_end':
		case 'lease_use_heartbeat':
		case 'lease_use_start':
			break;
		case 'tool_vm_binding_request':
		case 'tool_portal_approval_decide':
		case 'tool_portal_controller_execution':
			return {
				operation,
				reason:
					resolution.status === 'absent'
						? 'caller_context_absent'
						: resolution.status === 'session_mismatch'
							? 'caller_context_session_mismatch'
							: 'caller_context_stale',
				status: 'principal_rejected',
			};
	}
	switch (resolution.status) {
		case 'absent':
			return leaseCallerContextRejection({
				operation,
				reason: 'caller_context_absent',
			});
		case 'session_mismatch':
			return leaseCallerContextRejection({
				operation,
				reason: 'caller_context_session_mismatch',
			});
		case 'stale':
			return leaseCallerContextRejection({
				operation,
				reason: 'caller_context_stale',
			});
	}
	return assertUnreachableCallerContextResolution(resolution);
}

type ToolVmLeaseCallerContextResolution =
	| {
			readonly callerContext: GatewayControlTrustedCallerContext;
			readonly status: 'ok';
	  }
	| {
			readonly leaseRejectionReason: GatewayControlLeaseRejectionReason;
			readonly status: 'rejected';
	  };

function resolveCurrentToolVmLeaseCallerContext(options: {
	readonly callerContextId: string;
	readonly callerContexts: GatewayControlCallerContextRegistry;
	readonly session: GatewayControlCallerContextSessionRef;
}): ToolVmLeaseCallerContextResolution {
	const resolution = options.callerContexts.resolveForSession({
		callerContextId: options.callerContextId,
		session: options.session,
	});
	switch (resolution.status) {
		case 'ok':
			if (resolution.callerContext.purpose !== 'tool_vm_lease') {
				return { leaseRejectionReason: 'ownership_denied', status: 'rejected' };
			}
			return { callerContext: resolution.callerContext, status: 'ok' };
		case 'absent':
			return { leaseRejectionReason: 'caller_context_absent', status: 'rejected' };
		case 'stale':
			return { leaseRejectionReason: 'caller_context_stale', status: 'rejected' };
		case 'session_mismatch':
			return { leaseRejectionReason: 'caller_context_session_mismatch', status: 'rejected' };
	}
	return assertUnreachableCallerContextResolution(resolution);
}

function assertUnreachableCallerContextResolution(resolution: never): never {
	throw new Error(`unsupported caller-context resolution: ${JSON.stringify(resolution)}`);
}

function requireString(value: string | undefined, fieldName: string): string {
	if (value === undefined) {
		throw new Error(`gateway control health_event missing '${fieldName}'`);
	}
	return value;
}

function requireNumber(value: number | undefined, fieldName: string): number {
	if (value === undefined) {
		throw new Error(`gateway control health_event missing '${fieldName}'`);
	}
	return value;
}

function healthResultForGatewayInterface(
	result: GatewayControlHealthEventPayload['result'],
): AgentVmHealthEvent['result'] {
	return result === 'degraded' ? 'stale' : result;
}

function providerHealthForGatewayInterface(
	health: GatewayControlProviderRuntimeHealth,
): 'healthy' | 'transitioning' | 'unhealthy-recoverable' | 'unhealthy-unrecoverable' {
	switch (health) {
		case 'healthy':
			return 'healthy';
		case 'transitioning':
			return 'transitioning';
		case 'unhealthy_recoverable':
			return 'unhealthy-recoverable';
		case 'unhealthy_unrecoverable':
			return 'unhealthy-unrecoverable';
	}
	return assertUnreachableProviderHealth(health);
}

function assertUnreachableProviderHealth(health: never): never {
	throw new Error(`gateway control provider health is not supported: ${String(health)}`);
}

function assertUnreachableHealthPayload(payload: never): never {
	throw new Error(
		`gateway control health_event payload is not supported: ${JSON.stringify(payload)}`,
	);
}

function healthEventCorrelationFromPayload(
	correlation: GatewayControlHealthEventPayload['correlation'],
): Partial<
	Pick<
		AgentVmHealthEvent,
		| 'causationId'
		| 'correlationId'
		| 'requestId'
		| 'runId'
		| 'sessionKeyDigest'
		| 'toolCallId'
		| 'traceId'
	>
> {
	if (correlation === undefined) {
		return {};
	}
	return {
		...(correlation.causationId === undefined ? {} : { causationId: correlation.causationId }),
		...(correlation.correlationId === undefined
			? {}
			: { correlationId: correlation.correlationId }),
		...(correlation.requestId === undefined ? {} : { requestId: correlation.requestId }),
		...(correlation.runId === undefined ? {} : { runId: correlation.runId }),
		...(correlation.sessionKeyDigest === undefined
			? {}
			: { sessionKeyDigest: correlation.sessionKeyDigest }),
		...(correlation.toolCallId === undefined ? {} : { toolCallId: correlation.toolCallId }),
		...(correlation.traceId === undefined ? {} : { traceId: correlation.traceId }),
	};
}

function healthEventFromPayload(options: {
	readonly payload: GatewayControlHealthEventPayload;
	readonly zoneId: string;
}): AgentVmHealthEvent {
	const base = {
		...healthEventCorrelationFromPayload(options.payload.correlation),
		observedAtMs: options.payload.observedAtMs,
		result: healthResultForGatewayInterface(options.payload.result),
		zoneId: options.zoneId,
	};
	switch (options.payload.eventKind) {
		case 'agent-channel-provider-health':
			return {
				...base,
				channelProviderId: requireString(options.payload.channelProviderId, 'channelProviderId'),
				kind: 'agent-channel-provider-health',
				health: providerHealthForGatewayInterface(options.payload.providerRuntimeHealth),
			};
		case 'controller-request':
			return {
				...base,
				attempt: requireNumber(options.payload.attempt, 'attempt'),
				elapsedMs: requireNumber(options.payload.elapsedMs, 'elapsedMs'),
				...(options.payload.errorCode === undefined
					? {}
					: { errorCode: options.payload.errorCode }),
				kind: 'controller-request',
				maxAttempts: requireNumber(options.payload.maxAttempts, 'maxAttempts'),
				operation: options.payload.operation,
				...(options.payload.statusCode === undefined
					? {}
					: { statusCode: options.payload.statusCode }),
			};
		case 'gateway-control-session':
			return {
				...base,
				domain: 'gateway_control',
				elapsedMs: requireNumber(options.payload.elapsedMs, 'elapsedMs'),
				kind: 'gateway-control-session',
				operation: options.payload.operation,
				peerId: requireString(options.payload.safeDetails?.peerId, 'peerId'),
			};
		case 'gateway-plugin-health':
			return {
				...base,
				gatewayService: 'openclaw',
				kind: 'gateway-plugin-health',
				state: options.payload.result === 'ok' ? 'ready' : 'failed',
			};
		case 'tool-vm-ssh': {
			const toolVmHealthEventBase = {
				...base,
				agentId: requireString(options.payload.agentId, 'agentId'),
				elapsedMs: requireNumber(options.payload.elapsedMs, 'elapsedMs'),
				...(options.payload.errorCode === undefined
					? {}
					: { errorCode: options.payload.errorCode }),
				kind: 'tool-vm-ssh',
				leaseId: requireString(options.payload.leaseId, 'leaseId'),
				operation: options.payload.operation,
			} satisfies AgentVmHealthEvent;
			if (!('lifecycleEventRole' in options.payload)) {
				return toolVmHealthEventBase;
			}
			const lifecycleBase = {
				...(options.payload.activeUseId === undefined
					? {}
					: { activeUseId: options.payload.activeUseId }),
				...(options.payload.callerContextState === undefined
					? {}
					: { callerContextState: options.payload.callerContextState }),
				...(options.payload.leaseRejectionReason === undefined
					? {}
					: { leaseRejectionReason: options.payload.leaseRejectionReason }),
				lifecycleEventRole: options.payload.lifecycleEventRole,
				oldLeaseId: options.payload.oldLeaseId,
				transitionId: options.payload.transitionId,
			};
			if (
				options.payload.lifecycleTransition === 'deprecated_to_reacquired' ||
				options.payload.lifecycleTransition === 'stale_to_reacquired'
			) {
				return {
					...toolVmHealthEventBase,
					...lifecycleBase,
					lifecycleTransition: options.payload.lifecycleTransition,
					replacementLeaseId: requireString(
						options.payload.replacementLeaseId,
						'replacementLeaseId',
					),
				};
			}
			return {
				...toolVmHealthEventBase,
				...lifecycleBase,
				lifecycleTransition: options.payload.lifecycleTransition,
			};
		}
	}
	return assertUnreachableHealthPayload(options.payload);
}

function healthEventFromHeartbeat(options: {
	readonly envelope: {
		readonly peerId: string;
		readonly zoneId: string;
	};
	readonly payload: {
		readonly elapsedMs?: number | undefined;
		readonly observedAtMs: number;
	};
}): AgentVmHealthEvent {
	return {
		domain: 'gateway_control',
		elapsedMs: options.payload.elapsedMs ?? 0,
		kind: 'gateway-control-session',
		observedAtMs: options.payload.observedAtMs,
		operation: 'control-session-heartbeat',
		peerId: options.envelope.peerId,
		result: 'ok',
		zoneId: options.envelope.zoneId,
	};
}

function runtimeStatusFromPayload(options: {
	readonly envelope: ControlEnvelope;
	readonly payload: GatewayControlRuntimeStatusPayload;
	readonly zoneId: string;
}): OpenClawRuntimeStatusReport {
	if (options.payload.statusKind !== 'gondolin') {
		throw new Error(`unsupported gateway runtime status kind '${options.payload.statusKind}'`);
	}
	return {
		bootId: options.envelope.bootId,
		connectionId: options.envelope.connectionId,
		controllerEpoch: options.envelope.controllerEpoch,
		findings: options.payload.findings.map((finding) => ({
			hint: finding.safeMessage ?? finding.id,
			id: finding.id,
			ok: finding.ok,
		})),
		peerId: options.envelope.peerId,
		pluginId: 'gondolin',
		sessionId: options.envelope.sessionId,
		zoneId: options.zoneId,
	};
}

function commandResultPayload(options: {
	readonly activeOperationId?: string;
	readonly admissionPrincipal?: string;
	readonly approvalAdmission?: GatewayRuntimeApprovalAdmissionResult;
	readonly approvalDecision?: GatewayApprovalDecisionResult;
	readonly approvalDispatch?: GatewayRuntimeApprovalArmDispatchResult;
	readonly bindingRequest?: GatewayControlToolVmBindingRequestResult;
	readonly callerContextId?: string;
	readonly controllerExecution?: GatewayControlToolPortalControllerExecutionResult;
	readonly error?: {
		readonly errorClass: string;
		readonly retryable?: boolean;
		readonly safeMessage?: string;
	};
	readonly lease?: GatewayControlLeaseSnapshot;
	readonly leaseRejectionReason?: GatewayControlLeaseRejectionReason;
	readonly leaseUse?: GatewayControlLeaseUseSnapshot;
	readonly responseToMessageId: string;
	readonly result: CommandResultKind;
}): GatewayControlCommandResultPayload {
	return GatewayControlRpcResponsePayloadSchema.parse({
		...(options.activeOperationId === undefined
			? {}
			: { activeOperationId: options.activeOperationId }),
		...(options.callerContextId === undefined
			? {}
			: {
					callerContext: {
						...(options.admissionPrincipal === undefined
							? {}
							: { admissionPrincipal: options.admissionPrincipal }),
						callerContextId: options.callerContextId,
					},
				}),
		...(options.approvalAdmission === undefined
			? {}
			: { approvalAdmission: options.approvalAdmission }),
		...(options.approvalDecision === undefined
			? {}
			: { approvalDecision: options.approvalDecision }),
		...(options.approvalDispatch === undefined
			? {}
			: { approvalDispatch: options.approvalDispatch }),
		...(options.bindingRequest === undefined ? {} : { bindingRequest: options.bindingRequest }),
		...(options.controllerExecution === undefined
			? {}
			: { controllerExecution: options.controllerExecution }),
		...(options.error === undefined ? {} : { error: options.error }),
		...(options.lease === undefined ? {} : { lease: options.lease }),
		...(options.leaseRejectionReason === undefined
			? {}
			: { leaseRejectionReason: options.leaseRejectionReason }),
		...(options.leaseUse === undefined ? {} : { leaseUse: options.leaseUse }),
		responseToMessageId: options.responseToMessageId,
		result: options.result,
	});
}

function assertApprovalLedgerConfigured(
	approvalLedger: GatewayControlApprovalLedgerOperations | undefined,
): GatewayControlApprovalLedgerOperations {
	if (approvalLedger === undefined) {
		throw new Error('gateway control approval ledger is not configured');
	}
	return approvalLedger;
}

function projectManagedGatewayApprovalDecisionResult(
	result: ControllerApprovalDecisionResult,
): GatewayApprovalDecisionResult {
	if (result.kind === 'recorded') {
		return { kind: 'recorded', state: result.decision === 'approve' ? 'approved' : 'denied' };
	}
	return { kind: 'rejected', reason: result.reason };
}

function currentApprovalAuthorityContext(
	options: Pick<GatewayControlDomainHandlerOptions, 'gateway' | 'session'>,
): GatewayRuntimeApprovalAuthorityContext {
	return {
		controllerEpoch: options.gateway.controllerEpoch,
		frameworkEpoch: options.session.bootId,
		gatewayEpoch: options.gateway.gatewayEpochId,
		runtimeEpoch: options.gateway.generationId,
		zoneId: options.gateway.zoneId,
	};
}

function controllerExecutionCallerContextRef(
	payload: GatewayControlToolPortalControllerExecutionPayload,
): { readonly callerContextId: string } {
	return payload.kind === 'configured_cli' ? payload.callerContext : payload.action.callerContext;
}

function controllerExecutionApprovalReservation(
	payload: GatewayControlToolPortalControllerExecutionPayload,
): GatewayRuntimeApprovalDispatchReservation | undefined {
	return payload.kind === 'configured_cli'
		? payload.approvalReservation
		: payload.action.approvalReservation;
}

async function executeToolPortalControllerExecution(options: {
	readonly actions: GatewayControlControllerExecutionOperations | undefined;
	readonly approvalLedger: GatewayControlApprovalLedgerOperations | undefined;
	readonly approvalAuthorityContext: GatewayRuntimeApprovalAuthorityContext;
	readonly callerContexts: GatewayControlCallerContextRegistry;
	readonly createdAtMs: number;
	readonly expiresAtMs: number | undefined;
	readonly now: () => number;
	readonly payload: GatewayControlToolPortalControllerExecutionPayload;
	readonly propagateMutationFailure?: boolean;
	readonly responseToMessageId: string;
	readonly session: GatewayControlCallerContextSessionRef;
}): Promise<GatewayControlCommandResultPayload> {
	if (options.actions === undefined) {
		const callerContextRef = controllerExecutionCallerContextRef(options.payload);
		const callerContext = options.callerContexts.resolve(callerContextRef.callerContextId);
		if (callerContext?.purpose === 'tool_portal_controller_execution') {
			options.callerContexts.release(callerContext.callerContextId);
		}
		return commandResultPayload({
			error: {
				errorClass: 'controller_execution_unconfigured',
				retryable: false,
				safeMessage: 'controller execution handler is not configured',
			},
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		});
	}
	const callerContext = options.callerContexts.resolve(
		controllerExecutionCallerContextRef(options.payload).callerContextId,
	);
	if (callerContext === undefined) {
		return commandResultPayload({
			error: {
				errorClass: 'controller_execution_caller_context_absent',
				retryable: false,
				safeMessage: 'controller execution caller context is not registered',
			},
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		});
	}
	if (
		callerContext.bootId !== options.session.bootId ||
		callerContext.connectionId !== options.session.connectionId ||
		callerContext.controllerEpoch !== options.session.controllerEpoch ||
		callerContext.peerId !== options.session.peerId ||
		callerContext.sessionId !== options.session.sessionId ||
		callerContext.zoneId !== options.session.zoneId ||
		callerContext.purpose !== 'tool_portal_controller_execution'
	) {
		if (callerContext.purpose === 'tool_portal_controller_execution') {
			options.callerContexts.release(callerContext.callerContextId);
		}
		return commandResultPayload({
			error: {
				errorClass: 'controller_execution_caller_context_stale',
				retryable: false,
				safeMessage: 'controller execution caller context does not match session',
			},
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		});
	}
	try {
		const authorization = await options.actions.authorizeControllerExecution({
			callerContext,
			createdAtMs: options.createdAtMs,
			expiresAtMs: options.expiresAtMs,
			payload: options.payload,
			session: options.session,
		});
		if (!authorization.authorized) {
			return commandResultPayload({
				error: {
					errorClass: authorization.errorClass,
					retryable: false,
					safeMessage: authorization.safeMessage,
				},
				responseToMessageId: options.responseToMessageId,
				result: 'rejected',
			});
		}
		const approvalReservation = controllerExecutionApprovalReservation(options.payload);
		if (approvalReservation !== undefined) {
			if (approvalReservation.stablePrincipal !== callerContext.stablePrincipal) {
				return commandResultPayload({
					error: {
						errorClass: 'controller_execution_approval_principal_mismatch',
						retryable: false,
						safeMessage: 'controller execution approval does not match the caller',
					},
					responseToMessageId: options.responseToMessageId,
					result: 'rejected',
				});
			}
			const armResult = await assertApprovalLedgerConfigured(options.approvalLedger).armDispatch({
				authorityContext: options.approvalAuthorityContext,
				reservation: approvalReservation,
			});
			if (armResult.kind === 'not-dispatched') {
				return commandResultPayload({
					error: {
						errorClass: `controller_execution_approval_${armResult.reason.replaceAll('-', '_')}`,
						retryable: false,
						safeMessage: 'controller execution approval is no longer dispatchable',
					},
					responseToMessageId: options.responseToMessageId,
					result: 'rejected',
				});
			}
			if (armResult.kind === 'ambiguous') {
				return commandResultPayload({
					error: {
						errorClass: 'controller_execution_approval_dispatch_armed',
						retryable: false,
						safeMessage: 'controller execution approval dispatch state is ambiguous',
					},
					responseToMessageId: options.responseToMessageId,
					result: 'failed',
				});
			}
			const grant = armResult.grant;
			if (
				grant.backendKind !== 'controller_execution' ||
				grant.approvalId !== approvalReservation.approvalId ||
				grant.expiresAt !== approvalReservation.expiresAt ||
				grant.fingerprint !== approvalReservation.fingerprint ||
				grant.operationId !== approvalReservation.operationId ||
				grant.stablePrincipal !== approvalReservation.stablePrincipal ||
				grant.authorityContext.controllerEpoch !==
					approvalReservation.authorityContext.controllerEpoch ||
				grant.authorityContext.frameworkEpoch !==
					approvalReservation.authorityContext.frameworkEpoch ||
				grant.authorityContext.gatewayEpoch !== approvalReservation.authorityContext.gatewayEpoch ||
				grant.authorityContext.runtimeEpoch !== approvalReservation.authorityContext.runtimeEpoch ||
				grant.authorityContext.zoneId !== approvalReservation.authorityContext.zoneId
			) {
				return commandResultPayload({
					error: {
						errorClass: 'controller_execution_approval_grant_mismatch',
						retryable: false,
						safeMessage: 'controller execution approval grant is invalid',
					},
					responseToMessageId: options.responseToMessageId,
					result: 'failed',
				});
			}
		}
		if (options.payload.kind === 'configured_cli') {
			const commandCancellation = new AbortController();
			const remainingMilliseconds =
				options.expiresAtMs === undefined ? undefined : options.expiresAtMs - options.now();
			let expiryTimer: ReturnType<typeof setTimeout> | undefined;
			if (remainingMilliseconds !== undefined) {
				if (remainingMilliseconds <= 0) {
					commandCancellation.abort(
						new ConfiguredControllerExecutionError(
							'timeout',
							'Controller execution window expired.',
						),
					);
				} else {
					expiryTimer = setTimeout(
						() =>
							commandCancellation.abort(
								new ConfiguredControllerExecutionError(
									'timeout',
									'Controller execution window expired.',
								),
							),
						remainingMilliseconds,
					);
				}
			}
			let result: Awaited<ReturnType<typeof options.actions.executeConfiguredCli>>;
			try {
				result = await options.actions.executeConfiguredCli({
					callerContext,
					payload: options.payload,
					session: options.session,
					signal: commandCancellation.signal,
				});
			} finally {
				if (expiryTimer !== undefined) clearTimeout(expiryTimer);
			}
			return commandResultPayload({
				controllerExecution: {
					kind: 'configured_cli',
					operationName: options.payload.operationName,
					result,
				},
				responseToMessageId: options.responseToMessageId,
				result: 'ok',
			});
		}
		switch (options.payload.action.actionId) {
			case 'workspace_git_push': {
				const result = await options.actions.pushWorkspaceGit({
					callerContext,
					payload: options.payload.action,
					session: options.session,
				});
				return commandResultPayload({
					controllerExecution: {
						action: { actionId: 'workspace_git_push', result },
						kind: 'registered_action',
					},
					responseToMessageId: options.responseToMessageId,
					result: 'ok',
				});
			}
			case 'controller_host_probe': {
				const result = await options.actions.runControllerHostProbe({
					callerContext,
					payload: options.payload.action,
					session: options.session,
				});
				return commandResultPayload({
					controllerExecution: {
						action: { actionId: 'controller_host_probe', result },
						kind: 'registered_action',
					},
					responseToMessageId: options.responseToMessageId,
					result: 'ok',
				});
			}
		}
		return assertUnreachableControllerExecution(options.payload.action);
	} catch (error) {
		if (error instanceof ConfiguredControllerExecutionError) {
			const result =
				error.code === 'cancelled'
					? 'cancelled'
					: error.code === 'timeout'
						? 'timeout'
						: error.code === 'not_dispatched' || error.code === 'validation_failed'
							? 'rejected'
							: 'failed';
			return commandResultPayload({
				error: {
					errorClass: `controller_execution_${error.code}`,
					retryable: false,
					safeMessage: 'configured controller execution did not complete',
				},
				responseToMessageId: options.responseToMessageId,
				result,
			});
		}
		if (
			options.payload.kind === 'registered_action' &&
			options.payload.action.actionId === 'workspace_git_push' &&
			error instanceof WorkspaceGitPushRejectedError
		) {
			return commandResultPayload({
				error: {
					errorClass: error.errorClass,
					retryable: false,
					safeMessage: error.safeMessage,
				},
				responseToMessageId: options.responseToMessageId,
				result: 'rejected',
			});
		}
		if (
			options.propagateMutationFailure === true &&
			options.payload.kind === 'registered_action' &&
			options.payload.action.actionId === 'workspace_git_push'
		) {
			throw error;
		}
		return commandResultPayload({
			error: {
				errorClass: 'controller_execution_failed',
				retryable: true,
				safeMessage: 'controller execution failed',
			},
			responseToMessageId: options.responseToMessageId,
			result: 'failed',
		});
	} finally {
		options.callerContexts.release(callerContext.callerContextId);
	}
}

function assertUnreachableControllerExecution(payload: never): never {
	throw new Error(`unsupported controller execution action: ${JSON.stringify(payload)}`);
}

function isLeaseRpcRejection(
	result:
		| GatewayControlLeaseSnapshot
		| GatewayControlLeaseUseSnapshot
		| GatewayControlLeaseRpcRejection
		| undefined,
): result is GatewayControlLeaseRpcRejection {
	return result !== undefined && 'result' in result && result.result === 'rejected';
}

function leaseResultPayload(options: {
	readonly lease: GatewayControlLeaseSnapshot | GatewayControlLeaseRpcRejection | undefined;
	readonly leaseRejectionReason?: GatewayControlLeaseRejectionReason;
	readonly responseToMessageId: string;
}): GatewayControlCommandResultPayload {
	if (isLeaseRpcRejection(options.lease)) {
		return commandResultPayload({
			leaseRejectionReason: options.lease.leaseRejectionReason,
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		});
	}
	return commandResultPayload({
		...(options.lease === undefined
			? {
					leaseRejectionReason: options.leaseRejectionReason ?? 'lease_absent',
					result: 'rejected' as const,
				}
			: { lease: options.lease, result: 'ok' as const }),
		responseToMessageId: options.responseToMessageId,
	});
}

function leaseUseResultPayload(options: {
	readonly leaseUse: GatewayControlLeaseUseSnapshot | GatewayControlLeaseRpcRejection | undefined;
	readonly leaseRejectionReason?: GatewayControlLeaseRejectionReason;
	readonly responseToMessageId: string;
}): GatewayControlCommandResultPayload {
	if (isLeaseRpcRejection(options.leaseUse)) {
		return commandResultPayload({
			leaseRejectionReason: options.leaseUse.leaseRejectionReason,
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		});
	}
	return commandResultPayload({
		...(options.leaseUse === undefined
			? {
					leaseRejectionReason: options.leaseRejectionReason ?? 'lease_absent',
					result: 'rejected' as const,
				}
			: { leaseUse: options.leaseUse, result: 'ok' as const }),
		responseToMessageId: options.responseToMessageId,
	});
}

function isLeaseSemanticMutationOperation(
	operation: GatewayControlRpcMessage['operation'],
): operation is GatewayControlLeaseSemanticMutationOperation {
	return (
		operation === 'lease_create' ||
		operation === 'lease_reacquire' ||
		operation === 'lease_release' ||
		operation === 'lease_renew' ||
		operation === 'lease_use_end' ||
		operation === 'lease_use_heartbeat' ||
		operation === 'lease_use_start'
	);
}

function isLeaseSemanticMutationMessage(
	message: GatewayControlRpcMessage,
): message is GatewayControlLeaseSemanticMutationMessage {
	return message.kind === 'command' && isLeaseSemanticMutationOperation(message.operation);
}

function requireSemanticEnvelopeField(
	value: string | number | undefined,
	fieldName: 'attachmentGeneration' | 'commandId' | 'expiresAtMs' | 'idempotencyKey',
): string | number {
	if (value === undefined) {
		throw new Error(`gateway semantic mutation missing '${fieldName}'`);
	}
	return value;
}

function buildLeaseSemanticMutationPreparationOptions(options: {
	readonly attachmentGeneration: number;
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly gateway: GatewayEpochIdentity;
	readonly message: GatewayControlLeaseSemanticMutationMessage;
	readonly processEpoch: string;
}): GatewayControlLeaseSemanticMutationPreparationOptions {
	const base = {
		attachmentGeneration: options.attachmentGeneration,
		callerContext: options.callerContext,
		gateway: options.gateway,
		processEpoch: options.processEpoch,
	};
	switch (options.message.operation) {
		case 'lease_create':
			return { ...base, operation: 'lease_create', payload: options.message.payload };
		case 'lease_reacquire':
			return { ...base, operation: 'lease_reacquire', payload: options.message.payload };
		case 'lease_release':
			return { ...base, operation: 'lease_release', payload: options.message.payload };
		case 'lease_renew':
			return { ...base, operation: 'lease_renew', payload: options.message.payload };
		case 'lease_use_end':
			return { ...base, operation: 'lease_use_end', payload: options.message.payload };
		case 'lease_use_heartbeat':
			return { ...base, operation: 'lease_use_heartbeat', payload: options.message.payload };
		case 'lease_use_start':
			return {
				...base,
				operation: 'lease_use_start',
				payload:
					options.message.payload.correlation === undefined
						? options.message.payload
						: {
								...options.message.payload,
								correlation: normalizeToolVmActiveUseCorrelation(
									options.message.payload.correlation,
								),
							},
			};
	}
	throw new Error('unsupported lease semantic mutation operation');
}

function buildLeaseSemanticMutationTransportResult(options: {
	readonly message: GatewayControlLeaseSemanticMutationMessage;
	readonly responseToMessageId: string;
	readonly semanticValue: GatewayControlLeaseSemanticMutationResult;
}): GatewayControlRpcMessage {
	const expectsLeaseUse =
		options.message.operation === 'lease_use_start' ||
		options.message.operation === 'lease_use_heartbeat' ||
		options.message.operation === 'lease_use_end';
	const semanticRejection = isLeaseRpcRejection(options.semanticValue);
	const parsedLeaseUse = GatewayControlLeaseUseSnapshotSchema.safeParse(options.semanticValue);
	const parsedLease = GatewayControlLeaseSnapshotSchema.safeParse(options.semanticValue);
	if (
		expectsLeaseUse &&
		options.semanticValue !== undefined &&
		!semanticRejection &&
		!parsedLeaseUse.success
	) {
		throw new Error(
			`gateway semantic completion for '${options.message.operation}' did not return a lease-use value`,
		);
	}
	if (
		!expectsLeaseUse &&
		options.semanticValue !== undefined &&
		!semanticRejection &&
		!parsedLease.success
	) {
		throw new Error(
			`gateway semantic completion for '${options.message.operation}' did not return a lease value`,
		);
	}
	return GatewayControlRpcCommandResultMessageSchema.parse({
		kind: 'command_result',
		operation: options.message.operation,
		payload: expectsLeaseUse
			? leaseUseResultPayload({
					leaseUse:
						options.semanticValue === undefined || semanticRejection
							? options.semanticValue
							: parsedLeaseUse.data,
					responseToMessageId: options.responseToMessageId,
				})
			: leaseResultPayload({
					lease:
						options.semanticValue === undefined || semanticRejection
							? options.semanticValue
							: parsedLease.data,
					responseToMessageId: options.responseToMessageId,
				}),
	});
}

function parseLeaseSemanticMutationResult(
	value: unknown,
): GatewayControlLeaseSemanticMutationResult {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === 'object' && value !== null && 'result' in value) {
		if (value.result !== 'rejected' || !('leaseRejectionReason' in value)) {
			throw new Error('gateway semantic lease mutation returned an invalid rejection');
		}
		return {
			leaseRejectionReason: GatewayControlLeaseRejectionReasonSchema.parse(
				value.leaseRejectionReason,
			),
			result: 'rejected',
		};
	}
	const parsedLease = GatewayControlLeaseSnapshotSchema.safeParse(value);
	if (parsedLease.success) {
		return parsedLease.data;
	}
	const parsedLeaseUse = GatewayControlLeaseUseSnapshotSchema.safeParse(value);
	if (parsedLeaseUse.success) {
		return parsedLeaseUse.data;
	}
	throw new Error('gateway semantic lease mutation returned an invalid domain value');
}

export function createGatewayControlDomainHandler(
	options: GatewayControlDomainHandlerOptions,
): ControlSessionDomainHandler {
	const now = options.now ?? Date.now;
	return {
		assertEnvelopeDeliveryPolicy: assertGatewayControlEnvelopeDeliveryPolicy,
		policyByKind: gatewayControlDeliveryPolicyByKind,
		policyByOperation: gatewayControlDeliveryPolicyByOperation,
		messageIdentity: ({ payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			return {
				kind: message.kind,
				...(message.operation === undefined ? {} : { operation: message.operation }),
			};
		},
		buildHandlerFailureResult: ({ envelope, payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (message.kind !== 'command') {
				return undefined;
			}
			return GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: message.operation,
				payload: commandResultPayload({
					error: {
						errorClass: 'gateway_control_handler_failed',
						retryable: true,
						safeMessage: `Gateway control command '${message.operation}' failed after acceptance.`,
					},
					responseToMessageId: envelope.messageId,
					result: 'failed',
				}),
			});
		},
		buildSemanticFailureResult: ({ envelope, payload }, decision) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (
				!isLeaseSemanticMutationMessage(message) &&
				!(
					message.kind === 'command' &&
					message.operation === 'tool_portal_controller_execution' &&
					message.payload.kind === 'registered_action' &&
					message.payload.action.actionId === 'workspace_git_push'
				)
			) {
				throw new Error('gateway semantic failure does not belong to a mutating operation');
			}
			return GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: message.operation,
				payload: commandResultPayload({
					error: {
						errorClass: `gateway_semantic_${decision.kind}`,
						retryable: false,
						safeMessage: `Gateway semantic mutation was refused: ${decision.kind}.`,
					},
					responseToMessageId: envelope.messageId,
					result: 'failed',
				}),
			});
		},
		buildSemanticTransportResult: ({ envelope, payload }, completedValue) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (
				message.kind === 'command' &&
				message.operation === 'tool_portal_controller_execution' &&
				message.payload.kind === 'registered_action' &&
				message.payload.action.actionId === 'workspace_git_push'
			) {
				const completedPayload = GatewayControlRpcResponsePayloadSchema.parse(completedValue);
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: message.operation,
					payload: {
						...completedPayload,
						responseToMessageId: envelope.messageId,
					},
				});
			}
			if (!isLeaseSemanticMutationMessage(message)) {
				throw new Error('gateway semantic completion does not belong to a lease mutation');
			}
			const semanticValue = parseLeaseSemanticMutationResult(completedValue);
			if (
				message.operation === 'lease_release' &&
				semanticValue !== undefined &&
				!isLeaseRpcRejection(semanticValue) &&
				GatewayControlLeaseSnapshotSchema.safeParse(semanticValue).success
			) {
				options.callerContexts.release(message.payload.callerContext.callerContextId);
			}
			return buildLeaseSemanticMutationTransportResult({
				message,
				responseToMessageId: envelope.messageId,
				semanticValue,
			});
		},
		prepareSemanticMutation: async ({ attachmentGeneration, envelope, payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (
				message.kind === 'command' &&
				message.operation === 'tool_portal_controller_execution' &&
				message.payload.kind === 'registered_action' &&
				message.payload.action.actionId === 'workspace_git_push'
			) {
				const requiredAttachmentGeneration = requireSemanticEnvelopeField(
					attachmentGeneration,
					'attachmentGeneration',
				);
				const commandId = requireSemanticEnvelopeField(envelope.commandId, 'commandId');
				const idempotencyKey = requireSemanticEnvelopeField(
					envelope.idempotencyKey,
					'idempotencyKey',
				);
				const processEpoch = envelope.bootId;
				const sessionId = envelope.sessionId;
				const validUntilMs = requireSemanticEnvelopeField(envelope.expiresAtMs, 'expiresAtMs');
				if (
					typeof requiredAttachmentGeneration !== 'number' ||
					typeof commandId !== 'string' ||
					typeof idempotencyKey !== 'string' ||
					typeof processEpoch !== 'string' ||
					typeof sessionId !== 'string' ||
					typeof validUntilMs !== 'number'
				) {
					throw new Error('gateway controller host semantic envelope fields have invalid types');
				}
				return {
					execute: async () =>
						await executeToolPortalControllerExecution({
							actions: options.controllerExecutions,
							approvalLedger: options.approvalLedger,
							approvalAuthorityContext: currentApprovalAuthorityContext(options),
							callerContexts: options.callerContexts,
							createdAtMs: envelope.createdAtMs,
							expiresAtMs: envelope.expiresAtMs,
							now,
							payload: message.payload,
							propagateMutationFailure: true,
							responseToMessageId: envelope.messageId,
							session: callerContextSessionFromEnvelope(envelope),
						}),
					identity: {
						commandId,
						gateway: options.gateway,
						idempotencyKey,
						operation: message.operation,
						profile: {
							attachmentGeneration: requiredAttachmentGeneration,
							kind: 'session_safety',
							processEpoch,
							sessionId,
						},
						target: `controller_execution:${message.payload.action.actionId}:${message.payload.action.callerContext.callerContextId}`,
						validUntilMs,
					},
					payload: parseGatewaySemanticJsonValue(message.payload),
				};
			}
			if (!isLeaseSemanticMutationMessage(message)) {
				return undefined;
			}
			const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
				callerContextId: message.payload.callerContext.callerContextId,
				callerContexts: options.callerContexts,
				session: callerContextSessionFromEnvelope(envelope),
			});
			if (callerContextResolution.status === 'rejected') {
				return undefined;
			}
			const requiredAttachmentGeneration = requireSemanticEnvelopeField(
				attachmentGeneration,
				'attachmentGeneration',
			);
			const commandId = requireSemanticEnvelopeField(envelope.commandId, 'commandId');
			const idempotencyKey = requireSemanticEnvelopeField(
				envelope.idempotencyKey,
				'idempotencyKey',
			);
			const validUntilMs = requireSemanticEnvelopeField(envelope.expiresAtMs, 'expiresAtMs');
			if (
				typeof requiredAttachmentGeneration !== 'number' ||
				typeof commandId !== 'string' ||
				typeof idempotencyKey !== 'string' ||
				typeof validUntilMs !== 'number'
			) {
				throw new Error('gateway semantic mutation envelope fields have invalid types');
			}
			const preparationOptions = buildLeaseSemanticMutationPreparationOptions({
				attachmentGeneration: requiredAttachmentGeneration,
				callerContext: callerContextResolution.callerContext,
				gateway: options.gateway,
				message,
				processEpoch: envelope.bootId,
			});
			const normalizedPayload = preparationOptions.payload;
			const preparedMutation = await assertLeaseRpcConfigured(
				options.leaseRpc,
			).prepareSemanticMutation(preparationOptions);
			return {
				execute:
					message.operation === 'lease_reacquire'
						? async (proof) => {
								const result = await settleCommandWorkAtExpiry({
									expiresAtMs: validUntilMs,
									now,
									work: preparedMutation.execute(proof),
								});
								if (result.kind === 'expired') {
									throw new Error('Gateway lease reacquire command expired.');
								}
								return result.value;
							}
						: preparedMutation.execute,
				identity: {
					commandId,
					gateway: options.gateway,
					idempotencyKey,
					operation: message.operation,
					profile: preparedMutation.profile,
					target: preparedMutation.target,
					validUntilMs,
				},
				payload: parseGatewaySemanticJsonValue(normalizedPayload),
			};
		},
		handle: async ({ attachmentGeneration, envelope, payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			const callerContextSession = callerContextSessionFromEnvelope(envelope);
			if (message.kind === 'heartbeat') {
				if (options.recordHealthEvent === undefined) {
					throw new Error('gateway control heartbeat recorder is not configured');
				}
				options.recordHealthEvent(
					healthEventFromHeartbeat({
						envelope,
						payload: message.payload,
					}),
				);
				return undefined;
			}
			if (message.kind === 'event') {
				switch (message.operation) {
					case 'gateway_runtime_readiness': {
						options.recordGatewayRuntimeReadiness?.(message.payload);
						return undefined;
					}
					case 'health_event': {
						if (options.recordHealthEvent === undefined) {
							throw new Error('gateway control health_event recorder is not configured');
						}
						options.recordHealthEvent(
							healthEventFromPayload({
								payload: message.payload,
								zoneId: options.session.zoneId,
							}),
						);
						return undefined;
					}
					case 'runtime_status': {
						if (options.recordRuntimeStatus === undefined) {
							throw new Error('gateway control runtime_status recorder is not configured');
						}
						options.recordRuntimeStatus(
							runtimeStatusFromPayload({
								envelope,
								payload: message.payload,
								zoneId: options.session.zoneId,
							}),
						);
						return undefined;
					}
				}
			}
			if (message.kind !== 'command') {
				throw new Error(`gateway control handler cannot process '${message.kind}' messages`);
			}
			if (message.operation === 'control_ping') {
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: 'control_ping',
					payload: commandResultPayload({
						responseToMessageId: envelope.messageId,
						result: 'ok',
					}),
				});
			}
			switch (message.operation) {
				case 'tool_vm_binding_request': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'tool_vm_binding_request',
							payload: commandResultPayload({
								error: {
									errorClass: callerContextResolution.leaseRejectionReason,
									retryable: false,
									safeMessage: 'Tool VM binding caller context is not current.',
								},
								responseToMessageId: envelope.messageId,
								result: 'rejected',
							}),
						});
					}
					const expiresAtMs = requireSemanticEnvelopeField(envelope.expiresAtMs, 'expiresAtMs');
					if (typeof expiresAtMs !== 'number') {
						throw new Error('Gateway Tool VM binding command expiry is invalid.');
					}
					const bindingRequestResult = await settleCommandWorkAtExpiry({
						expiresAtMs,
						now,
						work: assertBindingPublicationConfigured(options.bindingPublication).requestBinding({
							authority: bindingPublicationAuthorityFromEnvelope({
								attachmentGeneration,
								envelope,
								gateway: options.gateway,
							}),
							callerContext: callerContextResolution.callerContext,
							expiresAtMs,
							gateway: options.gateway,
							payload: message.payload,
						}),
					});
					if (bindingRequestResult.kind === 'expired') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'tool_vm_binding_request',
							payload: commandResultPayload({
								error: {
									errorClass: 'tool_vm_binding_request_expired',
									retryable: true,
									safeMessage: 'Tool VM binding request exceeded its command deadline.',
								},
								responseToMessageId: envelope.messageId,
								result: 'timeout',
							}),
						});
					}
					const bindingRequest = bindingRequestResult.value;
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'tool_vm_binding_request',
						payload: commandResultPayload({
							bindingRequest,
							responseToMessageId: envelope.messageId,
							result: 'ok',
						}),
					});
				}
				case 'tool_vm_binding_publish':
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'tool_vm_binding_publish',
						payload: commandResultPayload({
							error: {
								errorClass: 'controller_only_operation',
								retryable: false,
								safeMessage: 'Tool VM binding publication is controller-origin only.',
							},
							responseToMessageId: envelope.messageId,
							result: 'rejected',
						}),
					});
				case 'tool_portal_approval_decide': {
					const callerContextResolution = options.callerContexts.resolveForSession({
						callerContextId: message.payload.callerContext.callerContextId,
						session: callerContextSession,
					});
					let approvalDecision: GatewayApprovalDecisionResult;
					if (
						callerContextResolution.status !== 'ok' ||
						callerContextResolution.callerContext.purpose !== 'tool_portal_approval_decision' ||
						options.managedApprovalAuthority === undefined
					) {
						approvalDecision = { kind: 'rejected', reason: 'presenter-not-authorized' };
					} else {
						const callerContext = callerContextResolution.callerContext;
						approvalDecision = projectManagedGatewayApprovalDecisionResult(
							await assertApprovalLedgerConfigured(options.approvalLedger).decide({
								approvalId: message.payload.decision.challengeId,
								authorityContext: currentApprovalAuthorityContext(options),
								decision: message.payload.decision.decision,
								operator: {
									approverId: options.managedApprovalAuthority.approverId,
									audience: 'agent-vm-controller-approval',
									provenance: 'managed-gateway',
									stablePrincipal: callerContext.stablePrincipal,
								},
							}),
						);
					}
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: message.operation,
						payload: commandResultPayload({
							approvalDecision,
							responseToMessageId: envelope.messageId,
							result: 'ok',
						}),
					});
				}
				case 'tool_portal_admission_reserve': {
					const approvalAdmission = await assertApprovalLedgerConfigured(
						options.approvalLedger,
					).requestApproval({
						authorityContext: currentApprovalAuthorityContext(options),
						intent: message.payload.intent,
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: message.operation,
						payload: commandResultPayload({
							approvalAdmission,
							responseToMessageId: envelope.messageId,
							result: 'ok',
						}),
					});
				}
				case 'tool_portal_dispatch_arm': {
					const approvalDispatch = GatewayRuntimeApprovalArmDispatchResultSchema.parse(
						await assertApprovalLedgerConfigured(options.approvalLedger).armDispatch({
							authorityContext: currentApprovalAuthorityContext(options),
							reservation: message.payload.reservation,
						}),
					);
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: message.operation,
						payload: commandResultPayload({
							approvalDispatch,
							responseToMessageId: envelope.messageId,
							result: 'ok',
						}),
					});
				}
				case 'caller_context_register': {
					const callerContext = options.callerContexts.register({
						payload: message.payload,
						session: callerContextSession,
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'caller_context_register',
						payload: commandResultPayload({
							admissionPrincipal: callerContext.stablePrincipal,
							callerContextId: callerContext.callerContextId,
							responseToMessageId: envelope.messageId,
							result: 'ok',
						}),
					});
				}
				case 'lease_create': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'lease_create',
							payload: commandResultPayload({
								leaseRejectionReason: callerContextResolution.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
								result: 'rejected',
							}),
						});
					}
					throw new Error('lease_create must execute through semantic preparation');
				}
				case 'lease_get':
				case 'lease_peek': {
					const callerContext =
						message.payload.callerContext === undefined
							? undefined
							: resolveCurrentToolVmLeaseCallerContext({
									callerContextId: message.payload.callerContext.callerContextId,
									callerContexts: options.callerContexts,
									session: callerContextSession,
								});
					if (message.payload.callerContext !== undefined && callerContext?.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: message.operation,
							payload: leaseResultPayload({
								lease: undefined,
								leaseRejectionReason: callerContext.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
							}),
						});
					}
					const lease = await assertLeaseRpcConfigured(options.leaseRpc).getLease(
						{
							callerContext:
								callerContext === undefined || callerContext.status === 'rejected'
									? undefined
									: callerContext.callerContext,
							gateway: options.gateway,
							payload: message.payload,
						},
						{
							includeSsh: message.operation === 'lease_get' ? 'private' : 'public',
						},
					);
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: message.operation,
						payload: leaseResultPayload({
							lease,
							responseToMessageId: envelope.messageId,
						}),
					});
				}
				case 'lease_reacquire': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'lease_reacquire',
							payload: leaseResultPayload({
								lease: undefined,
								leaseRejectionReason: callerContextResolution.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
							}),
						});
					}
					throw new Error('lease_reacquire must execute through semantic preparation');
				}
				case 'lease_renew': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'lease_renew',
							payload: leaseResultPayload({
								lease: undefined,
								leaseRejectionReason: callerContextResolution.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
							}),
						});
					}
					throw new Error('lease_renew must execute through semantic preparation');
				}
				case 'lease_release': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'lease_release',
							payload: leaseResultPayload({
								lease: undefined,
								leaseRejectionReason: callerContextResolution.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
							}),
						});
					}
					throw new Error('lease_release must execute through semantic preparation');
				}
				case 'lease_use_start': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'lease_use_start',
							payload: leaseUseResultPayload({
								leaseUse: undefined,
								leaseRejectionReason: callerContextResolution.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
							}),
						});
					}
					throw new Error('lease_use_start must execute through semantic preparation');
				}
				case 'lease_use_heartbeat': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'lease_use_heartbeat',
							payload: leaseUseResultPayload({
								leaseUse: undefined,
								leaseRejectionReason: callerContextResolution.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
							}),
						});
					}
					throw new Error('lease_use_heartbeat must execute through semantic preparation');
				}
				case 'lease_use_end': {
					const callerContextResolution = resolveCurrentToolVmLeaseCallerContext({
						callerContextId: message.payload.callerContext.callerContextId,
						callerContexts: options.callerContexts,
						session: callerContextSession,
					});
					if (callerContextResolution.status === 'rejected') {
						return GatewayControlRpcCommandResultMessageSchema.parse({
							kind: 'command_result',
							operation: 'lease_use_end',
							payload: leaseUseResultPayload({
								leaseUse: undefined,
								leaseRejectionReason: callerContextResolution.leaseRejectionReason,
								responseToMessageId: envelope.messageId,
							}),
						});
					}
					throw new Error('lease_use_end must execute through semantic preparation');
				}
				case 'tool_portal_controller_execution':
					if (
						message.payload.kind === 'registered_action' &&
						message.payload.action.actionId === 'workspace_git_push'
					) {
						throw new Error(
							'workspace_git_push controller execution action must execute through semantic preparation',
						);
					}
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'tool_portal_controller_execution',
						payload: await executeToolPortalControllerExecution({
							actions: options.controllerExecutions,
							approvalLedger: options.approvalLedger,
							approvalAuthorityContext: currentApprovalAuthorityContext(options),
							callerContexts: options.callerContexts,
							createdAtMs: envelope.createdAtMs,
							expiresAtMs: envelope.expiresAtMs,
							now,
							payload: message.payload,
							responseToMessageId: envelope.messageId,
							session: callerContextSession,
						}),
					});
				case 'operation_cancel':
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'operation_cancel',
						payload: commandResultPayload({
							activeOperationId: message.payload.activeOperationId,
							error: {
								errorClass:
									message.payload.initiatedBy === 'gateway'
										? 'active_operation_not_found'
										: 'controller_only_operation',
								retryable: false,
								safeMessage:
									message.payload.initiatedBy === 'gateway'
										? 'active operation is not tracked by this controller session'
										: 'controller-initiated cancel cannot be requested by the gateway',
							},
							responseToMessageId: envelope.messageId,
							result: 'rejected',
						}),
					});
				case 'recovery_command':
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'recovery_command',
						payload: commandResultPayload({
							error: {
								errorClass: 'controller_only_operation',
								retryable: false,
								safeMessage: 'recovery commands must be issued by the controller',
							},
							responseToMessageId: envelope.messageId,
							result: 'rejected',
						}),
					});
			}
			throw new Error('gateway control operation is not supported');
		},
	};
}
