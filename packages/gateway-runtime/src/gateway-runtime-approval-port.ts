import type { GatewayStablePrincipalDigest } from '@agent-vm/agent-portal-sdk/contracts';
import {
	deriveGatewayControlStablePrincipal,
	GatewayControlRpcCommandMessageSchema,
	GatewayControlRpcCommandResultMessageSchema,
	GatewayRuntimeApprovalAdmissionResultSchema,
	GatewayRuntimeApprovalArmDispatchResultSchema,
	GatewayRuntimeApprovalChallengeIntentSchema,
	GatewayRuntimeGatewayDispatchReservationSchema,
	type GatewayControlRpcMessage,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeGatewayDispatchReservation,
} from '@agent-vm/gateway-control-contracts';
import type { ToolPortalApprovalPort } from '@agent-vm/tool-portal';

type GatewayRuntimeApprovalControlCommand = Extract<
	GatewayControlRpcMessage,
	{
		readonly kind: 'command';
		readonly operation: 'tool_portal_admission_reserve' | 'tool_portal_dispatch_arm';
	}
>;

export interface GatewayRuntimeApprovalControlCommandRequest {
	readonly admissionPrincipal: GatewayStablePrincipalDigest;
	readonly message: GatewayRuntimeApprovalControlCommand;
}

export interface GatewayRuntimeApprovalControlCommandResponse {
	readonly messageId: string;
	readonly response: unknown;
}

export interface GatewayRuntimeApprovalControlCommandPort {
	readonly sendCommand: (
		request: GatewayRuntimeApprovalControlCommandRequest,
	) => Promise<GatewayRuntimeApprovalControlCommandResponse>;
}

function assertMatchingAdmissionResult(props: {
	readonly admission: ReturnType<typeof GatewayRuntimeApprovalAdmissionResultSchema.parse>;
	readonly intent: GatewayRuntimeApprovalChallengeIntent;
	readonly stablePrincipal: GatewayStablePrincipalDigest;
}): void {
	switch (props.admission.kind) {
		case 'approval-required':
			if (JSON.stringify(props.admission.challenge.intent) !== JSON.stringify(props.intent)) {
				throw new Error('Gateway control approval challenge changed the requested intent.');
			}
			return;
		case 'dispatch-reserved':
			if (
				props.admission.reservation.operationId !== props.intent.operationId ||
				props.admission.reservation.backendKind !== props.intent.backendKind ||
				props.admission.reservation.stablePrincipal !== props.stablePrincipal
			) {
				throw new Error('Gateway control approval reservation changed dispatch authority.');
			}
			return;
		case 'not-dispatched':
		case 'ambiguous':
			if (props.admission.operationId !== props.intent.operationId) {
				throw new Error('Gateway control approval admission changed the operation identity.');
			}
	}
}

function assertMatchingDispatchResult(props: {
	readonly dispatch: ReturnType<typeof GatewayRuntimeApprovalArmDispatchResultSchema.parse>;
	readonly reservation: GatewayRuntimeGatewayDispatchReservation;
}): void {
	switch (props.dispatch.kind) {
		case 'dispatch-armed':
			if (
				props.dispatch.grant.approvalId !== props.reservation.approvalId ||
				props.dispatch.grant.backendKind !== props.reservation.backendKind ||
				props.dispatch.grant.expiresAt !== props.reservation.expiresAt ||
				props.dispatch.grant.fingerprint !== props.reservation.fingerprint ||
				props.dispatch.grant.operationId !== props.reservation.operationId ||
				props.dispatch.grant.stablePrincipal !== props.reservation.stablePrincipal ||
				JSON.stringify(props.dispatch.grant.authorityContext) !==
					JSON.stringify(props.reservation.authorityContext)
			) {
				throw new Error('Gateway control approval grant changed reserved dispatch authority.');
			}
			return;
		case 'not-dispatched':
		case 'ambiguous':
			if (props.dispatch.operationId !== props.reservation.operationId) {
				throw new Error('Gateway control approval dispatch changed the operation identity.');
			}
	}
}

export function createGatewayRuntimeApprovalPort(props: {
	readonly controlCommandPort: GatewayRuntimeApprovalControlCommandPort;
	readonly zoneId: string;
}): ToolPortalApprovalPort {
	if (props.zoneId.length === 0) {
		throw new Error('Gateway runtime approval port requires a zoneId.');
	}

	return {
		reserveDispatch: async ({ intent }) => {
			const parsedIntent = GatewayRuntimeApprovalChallengeIntentSchema.parse(intent);
			const admissionPrincipal = deriveGatewayControlStablePrincipal({
				principal: parsedIntent.trustedContext.principal,
			});
			const message = GatewayControlRpcCommandMessageSchema.parse({
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: parsedIntent },
			});
			if (message.operation !== 'tool_portal_admission_reserve') {
				throw new Error('Gateway runtime constructed the wrong approval admission command.');
			}
			const controlResult = await props.controlCommandPort.sendCommand({
				admissionPrincipal,
				message,
			});
			const response = GatewayControlRpcCommandResultMessageSchema.parse(controlResult.response);
			if (
				response.operation !== 'tool_portal_admission_reserve' ||
				response.payload.responseToMessageId !== controlResult.messageId ||
				response.payload.result !== 'ok' ||
				response.payload.approvalAdmission === undefined
			) {
				throw new Error('Gateway control did not return approval admission authority.');
			}
			const admission = GatewayRuntimeApprovalAdmissionResultSchema.parse(
				response.payload.approvalAdmission,
			);
			assertMatchingAdmissionResult({
				admission,
				intent: parsedIntent,
				stablePrincipal: admissionPrincipal,
			});
			return admission;
		},
		armDispatch: async ({ reservation }) => {
			const parsedReservation = GatewayRuntimeGatewayDispatchReservationSchema.parse(reservation);
			const message = GatewayControlRpcCommandMessageSchema.parse({
				kind: 'command',
				operation: 'tool_portal_dispatch_arm',
				payload: { reservation: parsedReservation },
			});
			if (message.operation !== 'tool_portal_dispatch_arm') {
				throw new Error('Gateway runtime constructed the wrong approval dispatch command.');
			}
			const controlResult = await props.controlCommandPort.sendCommand({
				admissionPrincipal: parsedReservation.stablePrincipal,
				message,
			});
			const response = GatewayControlRpcCommandResultMessageSchema.parse(controlResult.response);
			if (
				response.operation !== 'tool_portal_dispatch_arm' ||
				response.payload.responseToMessageId !== controlResult.messageId ||
				response.payload.result !== 'ok' ||
				response.payload.approvalDispatch === undefined
			) {
				throw new Error('Gateway control did not return approval dispatch authority.');
			}
			const dispatch = GatewayRuntimeApprovalArmDispatchResultSchema.parse(
				response.payload.approvalDispatch,
			);
			assertMatchingDispatchResult({ dispatch, reservation: parsedReservation });
			return dispatch;
		},
	};
}
