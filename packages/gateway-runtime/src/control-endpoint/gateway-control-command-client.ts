import { randomUUID } from 'node:crypto';

import {
	type GatewayStablePrincipalDigest,
	GatewayStablePrincipalDigestSchema,
} from '@agent-vm/agent-portal-sdk/contracts';
import {
	CONTROL_PROTOCOL_VERSION,
	ControlEnvelopeSchema,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcCommandMessageSchema,
	GatewayControlRpcCommandResultMessageSchema,
	deriveGatewayControlDeliveryPolicy,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	type GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';

import type {
	GatewayControlAcceptedSession,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';

export type GatewayRuntimeControlCommand = Extract<
	GatewayControlRpcMessage,
	{ readonly kind: 'command' }
>;

export type GatewayRuntimeControlCommandResult = Extract<
	GatewayControlRpcMessage,
	{ readonly kind: 'command_result' }
>;

export interface GatewayRuntimeControlCommandRequest {
	readonly admissionPrincipal?: GatewayStablePrincipalDigest;
	readonly commandId?: string;
	readonly commandResultTimeoutMs?: number;
	readonly createdAtMs?: number;
	readonly expiresAtMs?: number;
	readonly idempotencyKey?: string;
	readonly message: GatewayRuntimeControlCommand;
}

export interface GatewayRuntimeControlCommandResponse {
	readonly acceptedSession: GatewayControlAcceptedSession;
	readonly messageId: string;
	readonly response: GatewayRuntimeControlCommandResult;
}

export interface GatewayRuntimeControlCommandClient {
	readonly sendCommand: (
		request: GatewayRuntimeControlCommandRequest,
	) => Promise<GatewayRuntimeControlCommandResponse>;
}

export interface CreateGatewayRuntimeControlCommandClientProps {
	readonly controlService: Pick<GatewayControlService, 'emitApplicationMessage'>;
	readonly createMessageId?: () => string;
	readonly now?: () => number;
}

function acceptedSessionEnvelopeFields(
	acceptedSession: GatewayControlAcceptedSession,
): Pick<
	ControlEnvelope,
	'bootId' | 'connectionId' | 'controllerEpoch' | 'peerId' | 'sessionId' | 'zoneId'
> {
	return {
		bootId: acceptedSession.bootId,
		connectionId: acceptedSession.connectionId,
		controllerEpoch: acceptedSession.controllerEpoch,
		peerId: acceptedSession.peerId,
		sessionId: acceptedSession.sessionId,
		zoneId: acceptedSession.zoneId,
	};
}

export function createGatewayRuntimeControlCommandClient(
	props: CreateGatewayRuntimeControlCommandClientProps,
): GatewayRuntimeControlCommandClient {
	const createMessageId = props.createMessageId ?? randomUUID;
	const now = props.now ?? Date.now;

	return {
		sendCommand: async (request) => {
			const message = GatewayControlRpcCommandMessageSchema.parse(request.message);
			const admissionPrincipal =
				request.admissionPrincipal === undefined
					? undefined
					: GatewayStablePrincipalDigestSchema.parse(request.admissionPrincipal);
			const messageId = createMessageId();
			const createdAtMs = Math.max(1, request.createdAtMs ?? now());
			const deliveryPolicy = deriveGatewayControlDeliveryPolicy({
				...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
				kind: 'command',
				operation: message.operation,
			});
			let acceptedSession: GatewayControlAcceptedSession | undefined;
			const responseValue = await props.controlService.emitApplicationMessage(
				{
					buildEnvelope: ({ acceptedSession: candidateSession, sequence }) => {
						if (acceptedSession === undefined) {
							acceptedSession = candidateSession;
						} else if (acceptedSession !== candidateSession) {
							throw new Error('Gateway control accepted session changed during command emission.');
						}
						return ControlEnvelopeSchema.parse({
							...acceptedSessionEnvelopeFields(candidateSession),
							...(request.commandId === undefined ? {} : { commandId: request.commandId }),
							createdAtMs,
							deliveryPolicy,
							domain: 'gateway_control',
							...(request.expiresAtMs === undefined ? {} : { expiresAtMs: request.expiresAtMs }),
							...(request.idempotencyKey === undefined
								? {}
								: { idempotencyKey: request.idempotencyKey }),
							kind: 'command',
							messageId,
							operation: message.operation,
							protocolVersion: CONTROL_PROTOCOL_VERSION,
							sequence,
						});
					},
					domainMessage: { kind: 'command', operation: message.operation },
					payload: message,
				},
				{
					...(admissionPrincipal === undefined ? {} : { admissionPrincipal }),
					commandResultTimeoutMs:
						request.commandResultTimeoutMs ??
						gatewayControlCommandExecutionTimeoutMsByOperation[message.operation],
				},
			);
			if (acceptedSession === undefined) {
				throw new Error('Gateway control service did not bind the command to an accepted session.');
			}
			const response = GatewayControlRpcCommandResultMessageSchema.parse(responseValue);
			if (response.operation !== message.operation) {
				throw new Error('Gateway control command result operation did not match the request.');
			}
			if (response.payload.responseToMessageId !== messageId) {
				throw new Error('Gateway control command result did not correlate to the request message.');
			}
			return Object.freeze({ acceptedSession, messageId, response });
		},
	};
}
