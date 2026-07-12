import type { GatewayControlAdmissionClass } from './gateway-control-admission.js';
import type { GatewayControlRpcMessage } from './index.js';

export type GatewayControlAdmissionDirection = 'controller_to_gateway' | 'gateway_to_controller';

export type GatewayControlAdmissionClassification =
	| {
			readonly authoritySchedulingKey?: string;
			readonly coalesceKey?: string;
			readonly messageClass: GatewayControlAdmissionClass;
			readonly stablePrincipal?: string;
			readonly status: 'classified';
	  }
	| {
			readonly reason: 'stable_principal_required' | 'unproven_gateway_cancel';
			readonly status: 'refused';
	  }
	| {
			readonly reason: 'direction_violation' | 'forged_command_result';
			readonly status: 'fence';
	  };

export interface ClassifyGatewayControlAdmissionOptions {
	readonly controllerSafetyOperation?: boolean;
	readonly direction: GatewayControlAdmissionDirection;
	readonly matchedPendingResult?: boolean;
	readonly message: GatewayControlRpcMessage;
	readonly stablePrincipal?: string;
}

function authorityClassification(
	stablePrincipal: string | undefined,
): GatewayControlAdmissionClassification {
	return stablePrincipal === undefined || stablePrincipal.length === 0
		? { reason: 'stable_principal_required', status: 'refused' }
		: {
				authoritySchedulingKey: stablePrincipal,
				messageClass: 'authority',
				stablePrincipal,
				status: 'classified',
			};
}

function diagnosticCoalesceKey(
	payload: Extract<GatewayControlRpcMessage, { readonly operation: 'health_event' }>['payload'],
): string {
	return JSON.stringify([
		payload.eventKind,
		'leaseId' in payload ? payload.leaseId : undefined,
		'transitionId' in payload ? payload.transitionId : undefined,
		'operation' in payload ? payload.operation : undefined,
		'channelProviderId' in payload ? payload.channelProviderId : undefined,
	]);
}

export function classifyGatewayControlAdmission(
	options: ClassifyGatewayControlAdmissionOptions,
): GatewayControlAdmissionClassification {
	const message = options.message;
	if (message.kind === 'command_result') {
		return options.matchedPendingResult === true
			? { messageClass: 'safety', status: 'classified' }
			: { reason: 'forged_command_result', status: 'fence' };
	}
	if (message.kind === 'heartbeat') {
		return {
			coalesceKey: `${options.direction}:control-heartbeat`,
			messageClass: 'liveness',
			status: 'classified',
		};
	}
	if (message.kind === 'event') {
		if (options.direction !== 'gateway_to_controller') {
			return { reason: 'direction_violation', status: 'fence' };
		}
		switch (message.operation) {
			case 'runtime_status':
				return {
					coalesceKey: `runtime-status:${message.payload.statusKind}`,
					messageClass: 'liveness',
					status: 'classified',
				};
			case 'health_event':
				return {
					coalesceKey: diagnosticCoalesceKey(message.payload),
					messageClass: 'diagnostic',
					status: 'classified',
				};
		}
	}
	if (message.operation === 'control_ping') {
		return {
			coalesceKey: `${options.direction}:control-ping`,
			messageClass: 'liveness',
			status: 'classified',
		};
	}
	if (options.direction === 'controller_to_gateway') {
		switch (message.operation) {
			case 'operation_cancel':
				return options.controllerSafetyOperation === true &&
					message.payload.initiatedBy === 'controller'
					? { messageClass: 'safety', status: 'classified' }
					: { reason: 'direction_violation', status: 'fence' };
			case 'recovery_command':
				return options.controllerSafetyOperation === true
					? { messageClass: 'safety', status: 'classified' }
					: { reason: 'direction_violation', status: 'fence' };
			case 'caller_context_register':
			case 'lease_create':
			case 'lease_get':
			case 'lease_peek':
			case 'lease_reacquire':
			case 'lease_release':
			case 'lease_renew':
			case 'lease_use_start':
			case 'lease_use_heartbeat':
			case 'lease_use_end':
			case 'tool_portal_controller_host_action':
				return { reason: 'direction_violation', status: 'fence' };
		}
	}
	switch (message.operation) {
		case 'caller_context_register':
			return authorityClassification(options.stablePrincipal);
		case 'lease_renew':
			return options.stablePrincipal === undefined
				? { reason: 'stable_principal_required', status: 'refused' }
				: {
						coalesceKey: `${options.stablePrincipal}:lease:${message.payload.leaseId}`,
						messageClass: 'liveness',
						status: 'classified',
					};
		case 'lease_use_heartbeat':
			return options.stablePrincipal === undefined
				? { reason: 'stable_principal_required', status: 'refused' }
				: {
						coalesceKey: `${options.stablePrincipal}:lease:${message.payload.leaseId}:use:${message.payload.useId}`,
						messageClass: 'liveness',
						status: 'classified',
					};
		case 'operation_cancel':
			return message.payload.initiatedBy === 'gateway'
				? { reason: 'unproven_gateway_cancel', status: 'refused' }
				: { reason: 'direction_violation', status: 'fence' };
		case 'recovery_command':
			return { reason: 'direction_violation', status: 'fence' };
		case 'lease_create':
		case 'lease_get':
		case 'lease_peek':
		case 'lease_reacquire':
		case 'lease_release':
		case 'lease_use_start':
		case 'lease_use_end':
		case 'tool_portal_controller_host_action':
			return authorityClassification(options.stablePrincipal);
	}
	return { reason: 'direction_violation', status: 'fence' };
}
