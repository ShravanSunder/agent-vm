import {
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
} from '@agent-vm/gateway-control-contracts';

import type { GatewayControlApplicationMessageHandler } from './gateway-control-endpoint-contracts.js';

export function createGatewayRuntimeControlMessageHandler(): GatewayControlApplicationMessageHandler {
	return {
		buildHandlerFailureResult: ({ envelope, payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (message.kind !== 'command') return undefined;
			return GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: message.operation,
				payload: {
					error: {
						errorClass: 'gateway_control_handler_failed',
						retryable: true,
						safeMessage: `Gateway control command '${message.operation}' failed after acceptance.`,
					},
					responseToMessageId: envelope.messageId,
					result: 'failed',
				},
			});
		},
		handle: async ({ envelope, payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (message.kind !== 'command') return undefined;
			if (message.operation === 'control_ping') {
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: 'control_ping',
					payload: {
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				});
			}
			return GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: message.operation,
				payload: {
					error: {
						errorClass: 'unsupported_gateway_control_command',
						retryable: false,
						safeMessage: `Gateway control command '${message.operation}' is not implemented by this peer.`,
					},
					responseToMessageId: envelope.messageId,
					result: 'rejected',
				},
			});
		},
		messageIdentity: ({ payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			return {
				kind: message.kind,
				...(message.operation === undefined ? {} : { operation: message.operation }),
			};
		},
	};
}
