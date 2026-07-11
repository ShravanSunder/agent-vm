import type { ControlEnvelope } from '@agent-vm/control-protocol-contracts';
import {
	type GatewayControlLeaseCreateIntentPayload,
	type GatewayControlCallerContextRegisterPayload,
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
	type GatewayControlToolPortalControllerHostActionPayload,
	type GatewayControlToolPortalControllerHostActionResult,
	type GatewayControlRpcMessage,
	type GatewayControlZoneGitPushResult,
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
	GatewayControlRpcResponsePayloadSchema,
	assertGatewayControlEnvelopeDeliveryPolicy,
	gatewayControlDeliveryPolicyByKind,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import {
	normalizeToolVmActiveUseCorrelation,
	type AgentVmHealthEvent,
} from '@agent-vm/gateway-interface';

import type { OpenClawRuntimeStatusReport } from '../openclaw-runtime-status.js';
import type { ControlSessionDomainHandler } from './control-session-dispatcher.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlCallerContextSessionRef,
	GatewayControlCallerContextRegistry,
	GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';

export interface GatewayControlLeaseRpcOperations {
	createLease(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseCreateIntentPayload;
	}): Promise<GatewayControlLeaseSnapshot>;
	endLeaseUse(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseUseEndPayload;
	}): Promise<GatewayControlLeaseUseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
	getLease(
		request: {
			readonly callerContext: GatewayControlTrustedCallerContext | undefined;
			readonly payload: GatewayControlLeaseIdPayload;
		},
		readOptions: { readonly includeSsh: 'private' | 'public' | false },
	): Promise<GatewayControlLeaseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
	heartbeatLeaseUse(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseUseHeartbeatPayload;
	}): Promise<GatewayControlLeaseUseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
	reacquireLease(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseReacquireIntentPayload;
	}): Promise<GatewayControlLeaseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
	releaseLease(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseIdPayload;
	}): Promise<GatewayControlLeaseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
	renewLease(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseIdPayload;
	}): Promise<GatewayControlLeaseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
	startLeaseUse(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseUseStartPayload;
	}): Promise<GatewayControlLeaseUseSnapshot | GatewayControlLeaseRpcRejection | undefined>;
}

export interface GatewayControlLeaseRpcRejection {
	readonly leaseRejectionReason: GatewayControlLeaseRejectionReason;
	readonly result: 'rejected';
}

export interface GatewayControlControllerHostActionOperations {
	authorizeControllerHostAction(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlToolPortalControllerHostActionPayload;
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
	pushZoneGit(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: Extract<
			GatewayControlToolPortalControllerHostActionPayload,
			{ readonly actionId: 'zone_git_push' }
		>;
		readonly session: GatewayControlAcceptedSessionRef;
	}): Promise<GatewayControlZoneGitPushResult>;
	runControllerHostProbe(options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: Extract<
			GatewayControlToolPortalControllerHostActionPayload,
			{ readonly actionId: 'controller_host_probe' }
		>;
		readonly session: GatewayControlAcceptedSessionRef;
	}): Promise<GatewayControlControllerHostProbeResult>;
}

export interface GatewayControlDomainHandlerOptions {
	readonly callerContexts: GatewayControlCallerContextRegistry;
	readonly controllerHostActions?: GatewayControlControllerHostActionOperations;
	readonly leaseRpc?: GatewayControlLeaseRpcOperations;
	readonly recordHealthEvent?: (event: AgentVmHealthEvent) => void;
	readonly recordRuntimeStatus?: (report: OpenClawRuntimeStatusReport) => void;
	readonly session: GatewayControlAcceptedSessionRef;
	readonly validateCallerContextRegistration?: (
		payload: GatewayControlCallerContextRegisterPayload,
	) => void;
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
	readonly callerContextId?: string;
	readonly controllerHostAction?: GatewayControlToolPortalControllerHostActionResult;
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
		...(options.controllerHostAction === undefined
			? {}
			: { controllerHostAction: options.controllerHostAction }),
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

async function executeToolPortalControllerHostAction(options: {
	readonly actions: GatewayControlControllerHostActionOperations | undefined;
	readonly callerContexts: GatewayControlCallerContextRegistry;
	readonly payload: GatewayControlToolPortalControllerHostActionPayload;
	readonly responseToMessageId: string;
	readonly session: GatewayControlCallerContextSessionRef;
}): Promise<GatewayControlCommandResultPayload> {
	if (options.actions === undefined) {
		const callerContext = options.callerContexts.resolve(
			options.payload.callerContext.callerContextId,
		);
		if (callerContext?.purpose === 'tool_portal_controller_host_action') {
			options.callerContexts.release(callerContext.callerContextId);
		}
		return commandResultPayload({
			error: {
				errorClass: 'controller_host_action_unconfigured',
				retryable: false,
				safeMessage: 'controller host action handler is not configured',
			},
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		});
	}
	const callerContext = options.callerContexts.resolve(
		options.payload.callerContext.callerContextId,
	);
	if (callerContext === undefined) {
		return commandResultPayload({
			error: {
				errorClass: 'controller_host_action_caller_context_absent',
				retryable: false,
				safeMessage: 'controller host action caller context is not registered',
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
		callerContext.purpose !== 'tool_portal_controller_host_action'
	) {
		if (callerContext.purpose === 'tool_portal_controller_host_action') {
			options.callerContexts.release(callerContext.callerContextId);
		}
		return commandResultPayload({
			error: {
				errorClass: 'controller_host_action_caller_context_stale',
				retryable: false,
				safeMessage: 'controller host action caller context does not match session',
			},
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		});
	}
	try {
		const authorization = await options.actions.authorizeControllerHostAction({
			callerContext,
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
		switch (options.payload.actionId) {
			case 'zone_git_push': {
				const result = await options.actions.pushZoneGit({
					callerContext,
					payload: options.payload,
					session: options.session,
				});
				return commandResultPayload({
					controllerHostAction: {
						actionId: 'zone_git_push',
						result,
					},
					responseToMessageId: options.responseToMessageId,
					result: 'ok',
				});
			}
			case 'controller_host_probe': {
				const result = await options.actions.runControllerHostProbe({
					callerContext,
					payload: options.payload,
					session: options.session,
				});
				return commandResultPayload({
					controllerHostAction: {
						actionId: 'controller_host_probe',
						result,
					},
					responseToMessageId: options.responseToMessageId,
					result: 'ok',
				});
			}
		}
		return assertUnreachableControllerHostAction(options.payload);
	} catch {
		return commandResultPayload({
			error: {
				errorClass: 'controller_host_action_failed',
				retryable: true,
				safeMessage: 'controller host action failed',
			},
			responseToMessageId: options.responseToMessageId,
			result: 'failed',
		});
	} finally {
		options.callerContexts.release(callerContext.callerContextId);
	}
}

function assertUnreachableControllerHostAction(payload: never): never {
	throw new Error(`unsupported controller host action: ${JSON.stringify(payload)}`);
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

export function createGatewayControlDomainHandler(
	options: GatewayControlDomainHandlerOptions,
): ControlSessionDomainHandler {
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
		handle: async ({ envelope, payload }) => {
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
				case 'caller_context_register': {
					options.validateCallerContextRegistration?.(message.payload);
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
					const leaseRpc = assertLeaseRpcConfigured(options.leaseRpc);
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
					const lease = await leaseRpc.createLease({
						callerContext: callerContextResolution.callerContext,
						payload: message.payload,
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'lease_create',
						payload: commandResultPayload({
							lease,
							responseToMessageId: envelope.messageId,
							result: 'ok',
						}),
					});
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
					const lease = await assertLeaseRpcConfigured(options.leaseRpc).reacquireLease({
						callerContext: callerContextResolution.callerContext,
						payload: message.payload,
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'lease_reacquire',
						payload: leaseResultPayload({
							lease,
							responseToMessageId: envelope.messageId,
						}),
					});
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
					const lease = await assertLeaseRpcConfigured(options.leaseRpc).renewLease({
						callerContext: callerContextResolution.callerContext,
						payload: message.payload,
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'lease_renew',
						payload: leaseResultPayload({
							lease,
							responseToMessageId: envelope.messageId,
						}),
					});
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
					const lease = await assertLeaseRpcConfigured(options.leaseRpc).releaseLease({
						callerContext: callerContextResolution.callerContext,
						payload: message.payload,
					});
					if (lease !== undefined) {
						options.callerContexts.release(message.payload.callerContext.callerContextId);
					}
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'lease_release',
						payload: leaseResultPayload({
							lease,
							responseToMessageId: envelope.messageId,
						}),
					});
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
					const leaseUse = await assertLeaseRpcConfigured(options.leaseRpc).startLeaseUse({
						callerContext: callerContextResolution.callerContext,
						payload: {
							...message.payload,
							...(message.payload.correlation === undefined
								? {}
								: {
										correlation: normalizeToolVmActiveUseCorrelation(message.payload.correlation),
									}),
						},
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'lease_use_start',
						payload: leaseUseResultPayload({
							leaseUse,
							responseToMessageId: envelope.messageId,
						}),
					});
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
					const leaseUse = await assertLeaseRpcConfigured(options.leaseRpc).heartbeatLeaseUse({
						callerContext: callerContextResolution.callerContext,
						payload: message.payload,
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'lease_use_heartbeat',
						payload: leaseUseResultPayload({
							leaseUse,
							responseToMessageId: envelope.messageId,
						}),
					});
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
					const leaseUse = await assertLeaseRpcConfigured(options.leaseRpc).endLeaseUse({
						callerContext: callerContextResolution.callerContext,
						payload: message.payload,
					});
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'lease_use_end',
						payload: leaseUseResultPayload({
							leaseUse,
							responseToMessageId: envelope.messageId,
						}),
					});
				}
				case 'tool_portal_controller_host_action':
					return GatewayControlRpcCommandResultMessageSchema.parse({
						kind: 'command_result',
						operation: 'tool_portal_controller_host_action',
						payload: await executeToolPortalControllerHostAction({
							actions: options.controllerHostActions,
							callerContexts: options.callerContexts,
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
