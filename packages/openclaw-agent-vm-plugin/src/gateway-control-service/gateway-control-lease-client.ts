import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlDeliveryPolicy,
	type ControlEnvelope,
	type DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayControlLeaseRejectionReason,
	type GatewayControlLeaseSnapshot,
	type GatewayControlLeaseUseSnapshot,
	type GatewayControlRpcMessage,
	type GatewayControlRpcOperation,
} from '@agent-vm/gateway-control-contracts';
import {
	parseToolVmLeaseId,
	type ToolVmLeasePeek,
	type ToolVmSshLease,
} from '@agent-vm/gateway-interface';

import {
	ControllerLeaseRequestError,
	type JsonValue,
	type LeaseClient,
	type OpenClawGondolinLeaseReacquireRequest,
	type OpenClawGondolinLeaseRequest,
} from '../lease-client-contract.js';
import {
	signGatewayControlCallerContextAgentAuthority,
	signGatewayControlCallerContextProof,
} from './gateway-control-caller-context-proof.js';
import type { GatewayControlCallerContextStore } from './gateway-control-caller-context-store.js';
import type { GatewayControlIdentity, GatewayControlService } from './gateway-control-service.js';

type GatewayControlCommandResultMessage = Extract<
	GatewayControlRpcMessage,
	{ readonly kind: 'command_result' }
>;

type CreateGatewayControlId = () => string;

interface RegisteredCallerContextRef {
	readonly cacheKey: string;
	readonly callerContextId: string;
	readonly fromCache: boolean;
}

interface LeaseCallerContextRef {
	readonly cacheKey: string;
	readonly callerContextId: string;
	readonly request: OpenClawGondolinLeaseRequest;
}

interface GatewayControlCommandResultResponse {
	readonly messageId: string;
	readonly response: GatewayControlCommandResultMessage;
}

interface GatewayControlCommandRetryIdentity {
	readonly commandId: string;
	readonly idempotencyKey: string;
	readonly messageId: string;
}

export interface GatewayControlLeaseClientOptions {
	readonly callerContextStore?: GatewayControlCallerContextStore;
	readonly controlService: GatewayControlService;
	readonly createId?: CreateGatewayControlId;
	readonly identity: GatewayControlIdentity;
	readonly now?: () => number;
}

function createGatewayControlError(params: {
	readonly context: string;
	readonly message: string;
	readonly status: number;
}): ControllerLeaseRequestError {
	const responseBody = {
		message: params.message,
	} satisfies JsonValue;
	return new ControllerLeaseRequestError({
		bodyText: JSON.stringify(responseBody),
		context: params.context,
		responseBody,
		status: params.status,
	});
}

function statusForCommandResult(result: GatewayControlCommandResultMessage['payload']): number {
	if (result.result === 'timeout') {
		return 504;
	}
	if (result.result === 'failed') {
		return 500;
	}
	if (result.leaseRejectionReason === 'runtime_not_ready') {
		return 503;
	}
	if (
		result.leaseRejectionReason === 'caller_context_absent' ||
		result.leaseRejectionReason === 'lease_absent' ||
		result.leaseRejectionReason === 'lease_authority_absent'
	) {
		return 404;
	}
	if (
		result.leaseRejectionReason === 'lease_force_released' ||
		result.leaseRejectionReason === 'lease_generation_stale' ||
		result.leaseRejectionReason === 'lease_releasing' ||
		result.leaseRejectionReason === 'lease_retired' ||
		result.leaseRejectionReason === 'lease_use_tombstoned'
	) {
		return 410;
	}
	return 400;
}

function shouldRefreshCallerContextForLeaseRejection(
	rejectionReason: GatewayControlLeaseRejectionReason | undefined,
): boolean {
	return rejectionReason === 'caller_context_absent' || rejectionReason === 'caller_context_stale';
}

function staleEvidencePayloadForReacquireRequest(
	request: OpenClawGondolinLeaseReacquireRequest,
): OpenClawGondolinLeaseReacquireRequest['staleEvidence'] & { readonly observedAtMs: number } {
	return {
		...request.staleEvidence,
		observedAtMs: request.observedAtMs,
	};
}

function assertCommandResultOk(options: {
	readonly context: string;
	readonly operation: GatewayControlRpcOperation;
	readonly response: GatewayControlCommandResultMessage;
	readonly responseToMessageId: string;
}): void {
	if (options.response.operation !== options.operation) {
		throw createGatewayControlError({
			context: options.context,
			message: `gateway control response operation mismatch: ${options.response.operation}`,
			status: 502,
		});
	}
	if (options.response.payload.responseToMessageId !== options.responseToMessageId) {
		throw createGatewayControlError({
			context: options.context,
			message: 'gateway control response message correlation mismatch',
			status: 502,
		});
	}
	if (options.response.payload.result !== 'ok') {
		throw createGatewayControlError({
			context: options.context,
			message:
				options.response.payload.error?.safeMessage ??
				`gateway control command '${options.operation}' returned ${options.response.payload.result}`,
			status: statusForCommandResult(options.response.payload),
		});
	}
}

function requireLeaseSnapshot(options: {
	readonly context: string;
	readonly operation: GatewayControlRpcOperation;
	readonly response: GatewayControlCommandResultMessage;
}): GatewayControlLeaseSnapshot {
	const lease = options.response.payload.lease;
	if (lease === undefined) {
		throw createGatewayControlError({
			context: options.context,
			message: `gateway control command '${options.operation}' returned no lease snapshot`,
			status: 502,
		});
	}
	return lease;
}

function requireLeaseUseSnapshot(options: {
	readonly context: string;
	readonly operation: GatewayControlRpcOperation;
	readonly response: GatewayControlCommandResultMessage;
}): GatewayControlLeaseUseSnapshot {
	const leaseUse = options.response.payload.leaseUse;
	if (leaseUse === undefined) {
		throw createGatewayControlError({
			context: options.context,
			message: `gateway control command '${options.operation}' returned no lease-use snapshot`,
			status: 502,
		});
	}
	return leaseUse;
}

function requirePrivateToolVmLease(
	snapshot: GatewayControlLeaseSnapshot,
	context: string,
): ToolVmSshLease {
	if (snapshot.ssh?.identityPem === undefined || snapshot.ssh.knownHostsLine === undefined) {
		throw createGatewayControlError({
			context,
			message: 'gateway control lease snapshot did not include private SSH material',
			status: 502,
		});
	}
	return {
		agentId: snapshot.agentId,
		idleTtlMs: snapshot.idleTtlMs,
		leaseId: parseToolVmLeaseId(snapshot.leaseId),
		ssh: {
			host: snapshot.ssh.host,
			identityPem: snapshot.ssh.identityPem,
			knownHostsLine: snapshot.ssh.knownHostsLine,
			port: snapshot.ssh.port,
			user: snapshot.ssh.user,
		},
		tcpSlot: snapshot.tcpSlot,
		transport: snapshot.transport,
		workdir: snapshot.workdir,
	};
}

function requireAgentAuthorityKey(options: {
	readonly agentId: string;
	readonly keys: Readonly<Record<string, string>>;
}): string {
	const key = options.keys[options.agentId];
	if (key === undefined || key.length === 0) {
		throw createGatewayControlError({
			context: 'Gateway control caller_context_register',
			message: `gateway control missing caller-context agent authority for '${options.agentId}'`,
			status: 500,
		});
	}
	return key;
}

function requirePublicToolVmLeasePeek(
	snapshot: GatewayControlLeaseSnapshot,
	context: string,
): ToolVmLeasePeek {
	if (snapshot.ssh === undefined) {
		throw createGatewayControlError({
			context,
			message: 'gateway control lease snapshot did not include public SSH material',
			status: 502,
		});
	}
	return {
		agentId: snapshot.agentId,
		createdAt: 0,
		idleTtlMs: snapshot.idleTtlMs,
		lastUsedAt: 0,
		leaseId: parseToolVmLeaseId(snapshot.leaseId),
		profileId: 'unknown',
		ssh: {
			host: snapshot.ssh.host,
			port: snapshot.ssh.port,
			user: snapshot.ssh.user,
		},
		tcpSlot: snapshot.tcpSlot,
		transport: snapshot.transport,
		workdir: snapshot.workdir,
		zoneId: snapshot.zoneId,
	};
}

function requireActiveUseTiming(
	snapshot: GatewayControlLeaseUseSnapshot,
	context: string,
): { readonly expiresAt: number; readonly heartbeatAfterMs: number } {
	if (snapshot.expiresAt === undefined || snapshot.heartbeatAfterMs === undefined) {
		throw createGatewayControlError({
			context,
			message: 'gateway control lease-use snapshot did not include heartbeat timing',
			status: 502,
		});
	}
	return {
		expiresAt: snapshot.expiresAt,
		heartbeatAfterMs: snapshot.heartbeatAfterMs,
	};
}

export function buildGatewayControlCallerContextCacheKey(
	request: OpenClawGondolinLeaseRequest,
): string {
	return JSON.stringify({
		agentId: request.agentId,
		agentWorkspaceDir: request.agentWorkspaceDir,
		sessionKeyDigest: createHash('sha256').update(request.sessionKey).digest('base64url'),
		workMountDir: request.workMountDir,
		zoneId: request.zoneId,
	});
}

function callerContextScopeForLeaseRequest(request: OpenClawGondolinLeaseRequest): {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly purpose: 'tool_vm_lease';
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
} {
	return {
		agentId: request.agentId,
		agentWorkspaceDir: request.agentWorkspaceDir,
		purpose: 'tool_vm_lease',
		sessionKey: request.sessionKey,
		workMountDir: request.workMountDir,
		zoneId: request.zoneId,
	};
}

function callerContextPayloadForContext(callerContextId: string): {
	readonly callerContext: { readonly callerContextId: string };
} {
	return {
		callerContext: {
			callerContextId,
		},
	};
}

export function createGatewayControlLeaseClient(
	options: GatewayControlLeaseClientOptions,
): LeaseClient {
	const createId = options.createId ?? randomUUID;
	const now = options.now ?? (() => Date.now());
	const callerContextIdByCacheKey = new Map<string, string>();
	const callerContextByLeaseId = new Map<string, LeaseCallerContextRef>();
	const reacquireRequestByRetiredLeaseId = new Map<string, OpenClawGondolinLeaseRequest>();

	const sendCommandUnchecked = async (
		operation: GatewayControlRpcOperation,
		payload: unknown,
		commandOptions: { readonly retryIdentity?: GatewayControlCommandRetryIdentity } = {},
	): Promise<GatewayControlCommandResultResponse> => {
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation,
			payload,
		});
		const acceptedSession = await options.controlService.getAcceptedSession();
		const retryIdentity = commandOptions.retryIdentity ?? createCommandRetryIdentity(operation);
		const messageId = retryIdentity.messageId;
		const envelope = {
			bootId: options.identity.bootId,
			commandId: retryIdentity.commandId,
			connectionId: acceptedSession.connectionId,
			controllerEpoch: options.identity.controllerEpoch,
			createdAtMs: Math.max(1, now()),
			deliveryPolicy: gatewayControlDeliveryPolicyByOperation[operation] as ControlDeliveryPolicy,
			domain: 'gateway_control',
			idempotencyKey: retryIdentity.idempotencyKey,
			kind: 'command',
			messageId,
			operation,
			peerId: options.identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: options.controlService.nextPeerSequence(),
			sessionId: acceptedSession.sessionId,
			zoneId: options.identity.zoneId,
		} satisfies ControlEnvelope;
		const domainMessage = {
			kind: 'command',
			operation,
		} satisfies DomainControlMessageIdentity;
		return {
			messageId,
			response: GatewayControlRpcCommandResultMessageSchema.parse(
				await options.controlService.emitApplicationMessage(envelope, domainMessage, message),
			),
		};
	};

	const createCommandRetryIdentity = (
		operation: GatewayControlRpcOperation,
	): GatewayControlCommandRetryIdentity => {
		const commandId = createId();
		return {
			commandId,
			idempotencyKey: `${operation}:${commandId}`,
			messageId: createId(),
		};
	};

	const sendCommand = async (
		operation: GatewayControlRpcOperation,
		payload: unknown,
	): Promise<GatewayControlCommandResultMessage> => {
		const { messageId, response } = await sendCommandUnchecked(operation, payload);
		assertCommandResultOk({
			context: `Gateway control ${operation}`,
			operation,
			response,
			responseToMessageId: messageId,
		});
		return response;
	};

	const sendCommandWithSingleRetry = async (
		operation: GatewayControlRpcOperation,
		payload: unknown,
		retryIdentity: GatewayControlCommandRetryIdentity,
	): Promise<GatewayControlCommandResultResponse> => {
		try {
			return await sendCommandUnchecked(operation, payload, { retryIdentity });
		} catch {
			return await sendCommandUnchecked(operation, payload, { retryIdentity });
		}
	};

	const registerCallerContext = async (
		request: OpenClawGondolinLeaseRequest,
		cacheOptions: { readonly forceRefresh?: boolean } = {},
	): Promise<RegisteredCallerContextRef> => {
		const cacheKey = buildGatewayControlCallerContextCacheKey(request);
		if (cacheOptions.forceRefresh === true) {
			callerContextIdByCacheKey.delete(cacheKey);
		}
		const cachedCallerContextId = callerContextIdByCacheKey.get(cacheKey);
		if (cachedCallerContextId !== undefined) {
			options.callerContextStore?.rememberCallerContextForAgent({
				callerContextId: cachedCallerContextId,
				...callerContextScopeForLeaseRequest(request),
			});
			return { cacheKey, callerContextId: cachedCallerContextId, fromCache: true };
		}
		const response = await sendCommand('caller_context_register', {
			adapterEvidence: {
				agentAuthority: signGatewayControlCallerContextAgentAuthority({
					input: {
						agentId: request.agentId,
						agentWorkspaceDir: request.agentWorkspaceDir,
						sessionKey: request.sessionKey,
						workMountDir: request.workMountDir,
						zoneId: request.zoneId,
					},
					key: requireAgentAuthorityKey({
						agentId: request.agentId,
						keys: options.identity.callerContextAgentAuthorityKeys,
					}),
					keyId: request.agentId,
				}),
				agentId: request.agentId,
				agentWorkspaceDir: request.agentWorkspaceDir,
				proof: signGatewayControlCallerContextProof({
					input: {
						agentId: request.agentId,
						agentWorkspaceDir: request.agentWorkspaceDir,
						sessionKey: request.sessionKey,
						workMountDir: request.workMountDir,
						zoneId: request.zoneId,
					},
					proofKey: options.identity.callerContextProofKey,
				}),
				sessionKey: request.sessionKey,
				workMountDir: request.workMountDir,
				zoneId: request.zoneId,
			},
		});
		const callerContextId = response.payload.callerContext?.callerContextId;
		if (callerContextId === undefined) {
			throw createGatewayControlError({
				context: 'Gateway control caller_context_register',
				message: 'gateway control caller_context_register returned no callerContextId',
				status: 502,
			});
		}
		callerContextIdByCacheKey.set(cacheKey, callerContextId);
		options.callerContextStore?.rememberCallerContextForAgent({
			callerContextId,
			...callerContextScopeForLeaseRequest(request),
		});
		return { cacheKey, callerContextId, fromCache: false };
	};

	const resolveCallerContextForLease = (leaseId: string): LeaseCallerContextRef | undefined =>
		callerContextByLeaseId.get(leaseId);

	const requireCallerContextForLease = (
		leaseId: string,
		context: string,
	): LeaseCallerContextRef => {
		const callerContext = resolveCallerContextForLease(leaseId);
		if (callerContext === undefined) {
			throw createGatewayControlError({
				context,
				message: `gateway control lease '${leaseId}' has no registered caller context`,
				status: 409,
			});
		}
		return callerContext;
	};

	const rememberCallerContextForLease = (leaseContext: {
		readonly leaseId: string;
		readonly registeredCallerContext: RegisteredCallerContextRef;
		readonly request: OpenClawGondolinLeaseRequest;
	}): void => {
		reacquireRequestByRetiredLeaseId.delete(leaseContext.leaseId);
		callerContextByLeaseId.set(leaseContext.leaseId, {
			cacheKey: leaseContext.registeredCallerContext.cacheKey,
			callerContextId: leaseContext.registeredCallerContext.callerContextId,
			request: leaseContext.request,
		});
	};

	const forgetRegisteredCallerContext = (
		request: OpenClawGondolinLeaseRequest,
		callerContext: RegisteredCallerContextRef | LeaseCallerContextRef,
	): void => {
		callerContextIdByCacheKey.delete(callerContext.cacheKey);
		options.callerContextStore?.forgetCallerContextForAgent(
			callerContextScopeForLeaseRequest(request),
		);
	};

	const forgetCallerContextForLease = (
		leaseId: string,
		leaseCallerContext: LeaseCallerContextRef,
		forgetOptions: { readonly retainReacquireRequest?: boolean } = {},
	): void => {
		callerContextByLeaseId.delete(leaseId);
		if (forgetOptions.retainReacquireRequest === true) {
			reacquireRequestByRetiredLeaseId.set(leaseId, leaseCallerContext.request);
		} else {
			reacquireRequestByRetiredLeaseId.delete(leaseId);
		}
		forgetRegisteredCallerContext(leaseCallerContext.request, leaseCallerContext);
	};

	const sendLeaseCommandWithCallerContextRefresh = async (commandOptions: {
		readonly buildPayload: (
			callerContextPayload: ReturnType<typeof callerContextPayloadForContext>,
		) => unknown;
		readonly context: string;
		readonly leaseId: string;
		readonly operation: GatewayControlRpcOperation;
	}): Promise<GatewayControlCommandResultMessage> => {
		let leaseCallerContext = requireCallerContextForLease(
			commandOptions.leaseId,
			commandOptions.context,
		);
		let result = await sendCommandUnchecked(
			commandOptions.operation,
			commandOptions.buildPayload(
				callerContextPayloadForContext(leaseCallerContext.callerContextId),
			),
		);
		if (
			result.response.payload.result !== 'ok' &&
			shouldRefreshCallerContextForLeaseRejection(result.response.payload.leaseRejectionReason)
		) {
			forgetRegisteredCallerContext(leaseCallerContext.request, leaseCallerContext);
			const refreshedCallerContext = await registerCallerContext(leaseCallerContext.request, {
				forceRefresh: true,
			});
			rememberCallerContextForLease({
				leaseId: commandOptions.leaseId,
				registeredCallerContext: refreshedCallerContext,
				request: leaseCallerContext.request,
			});
			leaseCallerContext = requireCallerContextForLease(
				commandOptions.leaseId,
				commandOptions.context,
			);
			result = await sendCommandUnchecked(
				commandOptions.operation,
				commandOptions.buildPayload(
					callerContextPayloadForContext(leaseCallerContext.callerContextId),
				),
			);
			if (
				result.response.payload.result !== 'ok' &&
				shouldRefreshCallerContextForLeaseRejection(result.response.payload.leaseRejectionReason)
			) {
				forgetCallerContextForLease(commandOptions.leaseId, leaseCallerContext);
			}
		}
		assertCommandResultOk({
			context: commandOptions.context,
			operation: commandOptions.operation,
			response: result.response,
			responseToMessageId: result.messageId,
		});
		return result.response;
	};

	const registerReacquireCallerContext = async (
		oldLeaseId: string,
		context: string,
	): Promise<LeaseCallerContextRef> => {
		const liveCallerContext = resolveCallerContextForLease(oldLeaseId);
		if (liveCallerContext !== undefined) {
			return liveCallerContext;
		}
		const reacquireRequest = reacquireRequestByRetiredLeaseId.get(oldLeaseId);
		if (reacquireRequest === undefined) {
			return requireCallerContextForLease(oldLeaseId, context);
		}
		const registeredCallerContext = await registerCallerContext(reacquireRequest, {
			forceRefresh: true,
		});
		return {
			cacheKey: registeredCallerContext.cacheKey,
			callerContextId: registeredCallerContext.callerContextId,
			request: reacquireRequest,
		};
	};

	const sendLeaseReacquireCommand = async (
		oldLeaseId: string,
		request: OpenClawGondolinLeaseReacquireRequest,
	): Promise<{
		readonly leaseCallerContext: LeaseCallerContextRef;
		readonly response: GatewayControlCommandResultMessage;
	}> => {
		let leaseCallerContext = await registerReacquireCallerContext(
			oldLeaseId,
			'Gateway control lease_reacquire',
		);
		let result = await sendCommandUnchecked('lease_reacquire', {
			callerContext: { callerContextId: leaseCallerContext.callerContextId },
			...(request.idleTtlMs === undefined ? {} : { idleTtlHintMs: request.idleTtlMs }),
			oldLeaseId,
			staleEvidence: staleEvidencePayloadForReacquireRequest(request),
		});
		if (
			result.response.payload.result !== 'ok' &&
			shouldRefreshCallerContextForLeaseRejection(result.response.payload.leaseRejectionReason)
		) {
			forgetRegisteredCallerContext(leaseCallerContext.request, leaseCallerContext);
			const refreshedCallerContext = await registerCallerContext(leaseCallerContext.request, {
				forceRefresh: true,
			});
			leaseCallerContext = {
				cacheKey: refreshedCallerContext.cacheKey,
				callerContextId: refreshedCallerContext.callerContextId,
				request: leaseCallerContext.request,
			};
			result = await sendCommandUnchecked('lease_reacquire', {
				callerContext: { callerContextId: leaseCallerContext.callerContextId },
				...(request.idleTtlMs === undefined ? {} : { idleTtlHintMs: request.idleTtlMs }),
				oldLeaseId,
				staleEvidence: staleEvidencePayloadForReacquireRequest(request),
			});
			if (
				result.response.payload.result !== 'ok' &&
				shouldRefreshCallerContextForLeaseRejection(result.response.payload.leaseRejectionReason)
			) {
				forgetRegisteredCallerContext(leaseCallerContext.request, leaseCallerContext);
			}
		}
		assertCommandResultOk({
			context: 'Gateway control lease_reacquire',
			operation: 'lease_reacquire',
			response: result.response,
			responseToMessageId: result.messageId,
		});
		return {
			leaseCallerContext,
			response: result.response,
		};
	};

	return {
		endActiveUse: async (leaseId, useId, request) => {
			if (resolveCallerContextForLease(leaseId) === undefined) {
				return;
			}
			const response = await sendLeaseCommandWithCallerContextRefresh({
				buildPayload: (callerContext) => ({
					...callerContext,
					leaseId,
					reason: request.outcome === 'timed-out' ? 'timed_out' : request.outcome,
					useId,
				}),
				context: 'Gateway control lease_use_end',
				leaseId,
				operation: 'lease_use_end',
			});
			requireLeaseUseSnapshot({
				context: 'Gateway control lease_use_end',
				operation: 'lease_use_end',
				response,
			});
		},
		heartbeatActiveUse: async (leaseId, useId) => {
			const response = await sendLeaseCommandWithCallerContextRefresh({
				buildPayload: (callerContext) => ({
					...callerContext,
					leaseId,
					observedAtMs: Math.max(1, now()),
					useId,
				}),
				context: 'Gateway control lease_use_heartbeat',
				leaseId,
				operation: 'lease_use_heartbeat',
			});
			return requireActiveUseTiming(
				requireLeaseUseSnapshot({
					context: 'Gateway control lease_use_heartbeat',
					operation: 'lease_use_heartbeat',
					response,
				}),
				'Gateway control lease_use_heartbeat',
			);
		},
		peekLease: async (leaseId) => {
			const response = await sendLeaseCommandWithCallerContextRefresh({
				buildPayload: (callerContext) => ({
					...callerContext,
					leaseId,
				}),
				context: 'Gateway control lease_peek',
				leaseId,
				operation: 'lease_peek',
			});
			return requirePublicToolVmLeasePeek(
				requireLeaseSnapshot({
					context: 'Gateway control lease_peek',
					operation: 'lease_peek',
					response,
				}),
				'Gateway control lease_peek',
			);
		},
		reacquireLease: async (oldLeaseId, request) => {
			const { leaseCallerContext, response } = await sendLeaseReacquireCommand(oldLeaseId, request);
			const leaseSnapshot = requireLeaseSnapshot({
				context: 'Gateway control lease_reacquire',
				operation: 'lease_reacquire',
				response,
			});
			reacquireRequestByRetiredLeaseId.delete(oldLeaseId);
			rememberCallerContextForLease({
				leaseId: leaseSnapshot.leaseId,
				registeredCallerContext: {
					cacheKey: leaseCallerContext.cacheKey,
					callerContextId: leaseCallerContext.callerContextId,
					fromCache: true,
				},
				request: leaseCallerContext.request,
			});
			return requirePrivateToolVmLease(leaseSnapshot, 'Gateway control lease_reacquire');
		},
		releaseLease: async (leaseId, releaseOptions) => {
			const leaseCallerContext = resolveCallerContextForLease(leaseId);
			if (leaseCallerContext === undefined) {
				return;
			}
			await sendLeaseCommandWithCallerContextRefresh({
				buildPayload: (callerContext) => ({
					...callerContext,
					leaseId,
				}),
				context: 'Gateway control lease_release',
				leaseId,
				operation: 'lease_release',
			});
			forgetCallerContextForLease(leaseId, leaseCallerContext, {
				retainReacquireRequest: releaseOptions?.force === true,
			});
		},
		renewLease: async (leaseId) => {
			const response = await sendLeaseCommandWithCallerContextRefresh({
				buildPayload: (callerContext) => ({
					...callerContext,
					leaseId,
				}),
				context: 'Gateway control lease_renew',
				leaseId,
				operation: 'lease_renew',
			});
			return requirePrivateToolVmLease(
				requireLeaseSnapshot({
					context: 'Gateway control lease_renew',
					operation: 'lease_renew',
					response,
				}),
				'Gateway control lease_renew',
			);
		},
		requestLease: async (request) => {
			let registeredCallerContext = await registerCallerContext(request);
			const leaseCreateRetryIdentity = createCommandRetryIdentity('lease_create');
			let result = await sendCommandWithSingleRetry(
				'lease_create',
				{
					callerContext: {
						callerContextId: registeredCallerContext.callerContextId,
					},
					...(request.idleTtlMs === undefined ? {} : { idleTtlHintMs: request.idleTtlMs }),
				},
				leaseCreateRetryIdentity,
			);
			if (
				result.response.payload.result !== 'ok' &&
				shouldRefreshCallerContextForLeaseRejection(result.response.payload.leaseRejectionReason) &&
				registeredCallerContext.fromCache
			) {
				forgetRegisteredCallerContext(request, registeredCallerContext);
				registeredCallerContext = await registerCallerContext(request, { forceRefresh: true });
				result = await sendCommandWithSingleRetry(
					'lease_create',
					{
						callerContext: {
							callerContextId: registeredCallerContext.callerContextId,
						},
						...(request.idleTtlMs === undefined ? {} : { idleTtlHintMs: request.idleTtlMs }),
					},
					createCommandRetryIdentity('lease_create'),
				);
				if (
					result.response.payload.result !== 'ok' &&
					shouldRefreshCallerContextForLeaseRejection(result.response.payload.leaseRejectionReason)
				) {
					forgetRegisteredCallerContext(request, registeredCallerContext);
				}
			}
			assertCommandResultOk({
				context: 'Gateway control lease_create',
				operation: 'lease_create',
				response: result.response,
				responseToMessageId: result.messageId,
			});
			const leaseSnapshot = requireLeaseSnapshot({
				context: 'Gateway control lease_create',
				operation: 'lease_create',
				response: result.response,
			});
			rememberCallerContextForLease({
				leaseId: leaseSnapshot.leaseId,
				registeredCallerContext,
				request,
			});
			return requirePrivateToolVmLease(leaseSnapshot, 'Gateway control lease_create');
		},
		startActiveUse: async (leaseId, request) => {
			const response = await sendLeaseCommandWithCallerContextRefresh({
				buildPayload: (callerContext) => ({
					...callerContext,
					...(request.correlation === undefined ? {} : { correlation: request.correlation }),
					leaseId,
					useId: request.useId,
				}),
				context: 'Gateway control lease_use_start',
				leaseId,
				operation: 'lease_use_start',
			});
			const leaseUse = requireLeaseUseSnapshot({
				context: 'Gateway control lease_use_start',
				operation: 'lease_use_start',
				response,
			});
			return {
				useId: leaseUse.useId,
				...requireActiveUseTiming(leaseUse, 'Gateway control lease_use_start'),
			};
		},
	};
}
