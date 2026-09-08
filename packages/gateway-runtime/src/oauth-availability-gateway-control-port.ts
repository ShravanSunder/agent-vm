import {
	GatewayControlRpcCommandMessageSchema,
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlCommandExecutionTimeoutMsByOperation,
} from '@agent-vm/gateway-control-contracts';
import {
	oauthToolAvailabilityBatchResultSchema,
	managedGooglePreflightResultSchema,
} from '@agent-vm/oauth-broker-contracts';
import type { ToolPortalOAuthAvailabilityPort } from '@agent-vm/tool-portal';

import type { GatewayControlCallerContextRegistrationClient } from './control-endpoint/gateway-control-caller-context-registration-client.js';
import type { GatewayRuntimeControlCommandClient } from './control-endpoint/gateway-control-command-client.js';

function requireNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new Error('OAuth availability request was cancelled.');
	}
}

export function createGatewayControlOAuthAvailabilityPort(props: {
	readonly callerContextRegistrationClient: GatewayControlCallerContextRegistrationClient;
	readonly controlCommandClient: GatewayRuntimeControlCommandClient;
	readonly now?: (() => number) | undefined;
}): ToolPortalOAuthAvailabilityPort {
	const now = props.now ?? Date.now;
	return {
		preflight: async ({ request, signal, trustedContext }) => {
			requireNotAborted(signal);
			const callerContext = await props.callerContextRegistrationClient.register({
				purpose: 'tool_portal_controller_execution',
				trustedContext,
			});
			requireNotAborted(signal);
			const message = GatewayControlRpcCommandMessageSchema.parse({
				kind: 'command',
				operation: 'tool_portal_google_preflight',
				payload: { callerContext: { callerContextId: callerContext.callerContextId }, request },
			});
			if (message.operation !== 'tool_portal_google_preflight')
				throw new Error('Unexpected Google preflight command.');
			const createdAtMs = Math.max(1, now());
			const result = await props.controlCommandClient.sendCommand({
				admissionPrincipal: callerContext.admissionPrincipal,
				createdAtMs,
				expiresAtMs:
					createdAtMs +
					gatewayControlCommandExecutionTimeoutMsByOperation.tool_portal_google_preflight,
				message,
			});
			requireNotAborted(signal);
			const response = GatewayControlRpcCommandResultMessageSchema.parse(result.response);
			if (
				response.operation !== 'tool_portal_google_preflight' ||
				response.payload.responseToMessageId !== result.messageId ||
				response.payload.result !== 'ok'
			)
				throw new Error('Controller did not return Google preflight.');
			return managedGooglePreflightResultSchema.parse(response.payload.googlePreflight);
		},
		resolve: async ({ request, signal, trustedContext }) => {
			requireNotAborted(signal);
			const callerContext = await props.callerContextRegistrationClient.register({
				purpose: 'tool_portal_oauth_availability',
				trustedContext,
			});
			requireNotAborted(signal);
			const message = GatewayControlRpcCommandMessageSchema.parse({
				kind: 'command',
				operation: 'tool_portal_oauth_availability',
				payload: {
					callerContext: { callerContextId: callerContext.callerContextId },
					request,
				},
			});
			if (message.operation !== 'tool_portal_oauth_availability') {
				throw new Error('Gateway Runtime constructed the wrong OAuth availability command.');
			}
			const createdAtMs = Math.max(1, now());
			const controlResult = await props.controlCommandClient.sendCommand({
				admissionPrincipal: callerContext.admissionPrincipal,
				createdAtMs,
				expiresAtMs:
					createdAtMs +
					gatewayControlCommandExecutionTimeoutMsByOperation.tool_portal_oauth_availability,
				message,
			});
			requireNotAborted(signal);
			const response = GatewayControlRpcCommandResultMessageSchema.parse(controlResult.response);
			if (
				response.operation !== 'tool_portal_oauth_availability' ||
				response.payload.responseToMessageId !== controlResult.messageId ||
				response.payload.result !== 'ok'
			) {
				throw new Error('Controller did not return OAuth availability.');
			}
			return oauthToolAvailabilityBatchResultSchema.parse(response.payload.oauthAvailabilityBatch);
		},
	};
}
