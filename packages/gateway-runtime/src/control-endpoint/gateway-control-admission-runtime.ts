import type { ControlEnvelope } from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcCommandResultMessageSchema,
	classifyGatewayControlAdmission,
	createGatewayControlAdmissionExecutor,
	type GatewayControlAdmissionClassification,
	type GatewayControlAdmissionExecutor,
	type GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';

export const GATEWAY_CONTROL_BOOTSTRAP_AUTHORITY_KEY = 'gateway-registration-bootstrap';

export interface GatewayControlSessionAdmissionRuntime {
	close(reason: string): void;
	classifyGatewayEgress(options: {
		readonly admissionPrincipal?: string;
		readonly message: GatewayControlRpcMessage;
	}): GatewayControlAdmissionClassification;
	readonly egress: GatewayControlAdmissionExecutor<GatewayControlRpcMessage>;
	readonly ingress: GatewayControlAdmissionExecutor<GatewayControlRpcMessage>;
}

export function buildGatewayControlAdmissionFailureResult(options: {
	readonly operation: string;
	readonly responseToMessageId: string;
	readonly status: string;
}): GatewayControlRpcMessage {
	return GatewayControlRpcCommandResultMessageSchema.parse({
		kind: 'command_result',
		operation: options.operation,
		payload: {
			error: {
				errorClass: `gateway_control_admission_${options.status}`,
				retryable: true,
				safeMessage: `Gateway control command was not executed because admission ${options.status}.`,
			},
			responseToMessageId: options.responseToMessageId,
			result: 'failed',
		},
	});
}

export function measureGatewayControlApplicationMessageBytes(
	envelope: ControlEnvelope,
	payload: GatewayControlRpcMessage,
): number {
	return Buffer.byteLength(JSON.stringify([envelope, payload]), 'utf8');
}

export function createGatewayControlSessionAdmissionRuntime(): GatewayControlSessionAdmissionRuntime {
	const ingress = createGatewayControlAdmissionExecutor<GatewayControlRpcMessage>();
	const egress = createGatewayControlAdmissionExecutor<GatewayControlRpcMessage>();
	return {
		close: (reason) => {
			ingress.close(reason);
			egress.close(reason);
		},
		classifyGatewayEgress: ({ admissionPrincipal, message }) =>
			message.kind === 'command' &&
			message.operation === 'caller_context_register' &&
			admissionPrincipal === undefined
				? {
						authoritySchedulingKey: GATEWAY_CONTROL_BOOTSTRAP_AUTHORITY_KEY,
						messageClass: 'authority',
						status: 'classified',
					}
				: classifyGatewayControlAdmission({
						direction: 'gateway_to_controller',
						message,
						...(admissionPrincipal === undefined ? {} : { stablePrincipal: admissionPrincipal }),
					}),
		egress,
		ingress,
	};
}
