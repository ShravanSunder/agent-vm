import {
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
} from '@agent-vm/gateway-control-contracts';

import { createGatewayRuntimeControlMessageHandler } from './gateway-control-default-message-handler.js';
import type { GatewayControlApplicationMessageHandler } from './gateway-control-endpoint-contracts.js';
import type {
	GatewayControlPublishedBindingApplyResult,
	GatewayControlPublishedBindingRuntime,
} from './gateway-control-published-binding-runtime.js';

export interface CreateGatewayControlBindingPublicationHandlerProps {
	readonly applyPublication: GatewayControlPublishedBindingRuntime['applyPublication'];
}

function ignoredPublicationIsIdempotent(
	result: Extract<GatewayControlPublishedBindingApplyResult, { readonly kind: 'ignored' }>,
): boolean {
	return result.reason === 'duplicate_publication';
}

export function createGatewayControlBindingPublicationHandler(
	props: CreateGatewayControlBindingPublicationHandlerProps,
): GatewayControlApplicationMessageHandler {
	const defaultHandler = createGatewayRuntimeControlMessageHandler();
	return {
		...(defaultHandler.buildHandlerFailureResult === undefined
			? {}
			: {
					buildHandlerFailureResult: (context, error) =>
						defaultHandler.buildHandlerFailureResult?.(context, error),
				}),
		handle: async (context) => {
			const message = GatewayControlRpcMessageSchema.parse(context.payload);
			if (message.kind !== 'command' || message.operation !== 'tool_vm_binding_publish') {
				return await defaultHandler.handle(context);
			}
			const result = await props.applyPublication(message.payload);
			if (result.kind === 'applied' || ignoredPublicationIsIdempotent(result)) {
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: 'tool_vm_binding_publish',
					payload: {
						responseToMessageId: context.envelope.messageId,
						result: 'ok',
					},
				});
			}
			return GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: 'tool_vm_binding_publish',
				payload: {
					error: {
						errorClass: result.reason,
						retryable: result.reason === 'runtime_closed',
						safeMessage: 'Tool VM binding publication is stale or not current.',
					},
					responseToMessageId: context.envelope.messageId,
					result: result.reason === 'runtime_closed' ? 'failed' : 'rejected',
				},
			});
		},
		messageIdentity: (context) => defaultHandler.messageIdentity(context),
	};
}
