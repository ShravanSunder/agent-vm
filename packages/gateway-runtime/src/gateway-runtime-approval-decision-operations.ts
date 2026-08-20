import {
	GatewayApprovalDecisionRequestSchema,
	GatewayApprovalDecisionResultSchema,
	type GatewayApprovalDecisionRequest,
	type GatewayApprovalDecisionResult,
} from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';
import { GatewayControlRpcCommandMessageSchema } from '@agent-vm/gateway-control-contracts';

import type { GatewayControlCallerContextRegistrationClient } from './control-endpoint/gateway-control-caller-context-registration-client.js';
import type { GatewayRuntimeControlCommandClient } from './control-endpoint/gateway-control-command-client.js';

export interface GatewayRuntimeApprovalDecisionInvocation {
	readonly publicRequest: GatewayApprovalDecisionRequest;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimeApprovalDecisionOperations {
	readonly decide: (
		invocation: GatewayRuntimeApprovalDecisionInvocation,
	) => Promise<GatewayApprovalDecisionResult>;
}

export function createGatewayRuntimeApprovalDecisionOperations(props: {
	readonly callerContextRegistrationClient: GatewayControlCallerContextRegistrationClient;
	readonly controlCommandClient: GatewayRuntimeControlCommandClient;
}): GatewayRuntimeApprovalDecisionOperations {
	return {
		decide: async (invocation) => {
			const decision = GatewayApprovalDecisionRequestSchema.parse(invocation.publicRequest);
			const callerContext = await props.callerContextRegistrationClient.register({
				purpose: 'tool_portal_approval_decision',
				trustedContext: invocation.trustedContext,
			});
			const message = GatewayControlRpcCommandMessageSchema.parse({
				kind: 'command',
				operation: 'tool_portal_approval_decide',
				payload: {
					callerContext: { callerContextId: callerContext.callerContextId },
					decision,
				},
			});
			if (message.operation !== 'tool_portal_approval_decide') {
				throw new Error('Gateway runtime constructed the wrong approval decision command.');
			}
			const response = await props.controlCommandClient.sendCommand({
				admissionPrincipal: callerContext.admissionPrincipal,
				message,
			});
			if (
				response.response.operation !== 'tool_portal_approval_decide' ||
				response.response.payload.result !== 'ok'
			) {
				throw new Error('Gateway control did not return an approval decision result.');
			}
			return GatewayApprovalDecisionResultSchema.parse(response.response.payload.approvalDecision);
		},
	};
}
