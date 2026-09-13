import {
	PortalAttachmentRequestSchema,
	PortalAttachmentResultSchema,
	type PortalAttachmentRequest,
	type PortalAttachmentResult,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk';
import {
	GatewayControlRpcCommandMessageSchema,
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlCommandExecutionTimeoutMsByOperation,
} from '@agent-vm/gateway-control-contracts';

import type { GatewayControlCallerContextRegistrationClient } from './control-endpoint/gateway-control-caller-context-registration-client.js';
import type { GatewayRuntimeControlCommandClient } from './control-endpoint/gateway-control-command-client.js';

export type GatewayControlNativeAttachmentPort = (request: {
	readonly publicRequest: PortalAttachmentRequest;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	readonly signal: AbortSignal;
}) => Promise<PortalAttachmentResult>;

/** The protected invocation supplies the captured session; the tool never supplies a recipient. */
export function createGatewayControlNativeAttachmentPort(props: {
	readonly callerContextRegistrationClient: GatewayControlCallerContextRegistrationClient;
	readonly controlCommandClient: GatewayRuntimeControlCommandClient;
	readonly now?: () => number;
}): GatewayControlNativeAttachmentPort {
	return async ({ publicRequest, trustedContext, signal }) => {
		signal.throwIfAborted();
		const request = PortalAttachmentRequestSchema.parse(publicRequest);
		const sessionId = trustedContext.correlation?.sessionId;
		if (sessionId === undefined || sessionId.length === 0) return { kind: 'unavailable' };
		const caller = await props.callerContextRegistrationClient.register({
			purpose: 'tool_portal_controller_execution',
			trustedContext,
		});
		signal.throwIfAborted();
		const createdAtMs = Math.max(1, (props.now ?? Date.now)());
		const command = await props.controlCommandClient.sendCommand({
			admissionPrincipal: caller.admissionPrincipal,
			createdAtMs,
			expiresAtMs:
				createdAtMs + gatewayControlCommandExecutionTimeoutMsByOperation.tool_portal_attachment,
			message: GatewayControlRpcCommandMessageSchema.parse({
				kind: 'command',
				operation: 'tool_portal_attachment',
				payload: { callerContext: { callerContextId: caller.callerContextId }, request, sessionId },
			}),
		});
		signal.throwIfAborted();
		const response = GatewayControlRpcCommandResultMessageSchema.parse(command.response);
		if (
			response.operation !== 'tool_portal_attachment' ||
			response.payload.responseToMessageId !== command.messageId ||
			response.payload.result !== 'ok'
		)
			throw new Error('Native attachment staging response did not match its request.');
		return PortalAttachmentResultSchema.parse(response.payload.nativeAttachment);
	};
}
