import { getLogger } from '@logtape/logtape';

import { createBoundedDiagnosticProperties } from '../observability/process-logging.js';

export type ControllerDiagnosticDomain =
	| 'gateway'
	| 'git'
	| 'heartbeat'
	| 'lease'
	| 'resource'
	| 'runtime';

export type ControllerDiagnosticEvent =
	| 'controller-diagnostic'
	| 'controller-operation-failed'
	| 'gateway-health-diagnostic'
	| 'gateway-recovery-diagnostic'
	| 'heartbeat-diagnostic'
	| 'lease-diagnostic'
	| 'lease-liveness-failed'
	| 'resource-loader-diagnostic'
	| 'runtime-diagnostic'
	| 'task-state-diagnostic';

export type ControllerDiagnosticLevel = 'info' | 'warning';
export type ControllerDiagnosticFailureClass = 'failure' | 'rejected' | 'timeout' | 'unavailable';

export interface ControllerDiagnosticTelemetry {
	readonly attempt?: number | undefined;
	readonly durationMs?: number | undefined;
	readonly errorClass?: string | undefined;
	readonly errorCode?: string | undefined;
	readonly leaseId?: string | undefined;
	readonly operation?: string | undefined;
	readonly statusCode?: number | undefined;
	readonly zoneId?: string | undefined;
}

export type ControllerDiagnosticLogContext = ControllerDiagnosticTelemetry & {
	readonly operation: string;
};

export type ControllerDiagnosticDescriptor = (
	| {
			readonly event: ControllerDiagnosticEvent;
			readonly level: 'info';
	  }
	| {
			readonly event: ControllerDiagnosticEvent;
			readonly failureClass: ControllerDiagnosticFailureClass;
			readonly level: 'warning';
	  }
) & {
	readonly telemetry?: ControllerDiagnosticTelemetry | undefined;
};

type ControllerDiagnosticProperties = Readonly<Record<string, boolean | number | string>>;

export function createControllerDiagnosticProperties(
	descriptor: ControllerDiagnosticDescriptor,
): ControllerDiagnosticProperties {
	return createBoundedDiagnosticProperties({
		...descriptor.telemetry,
		event: descriptor.event,
		...(descriptor.level === 'warning' ? { failureClass: descriptor.failureClass } : {}),
	});
}

export function writeControllerDiagnostic(
	domain: ControllerDiagnosticDomain,
	descriptor: ControllerDiagnosticDescriptor,
): void {
	const properties = createControllerDiagnosticProperties(descriptor);
	const logger = getLogger(['agent-vm', 'controller', domain]);
	if (descriptor.level === 'warning') {
		logger.warn('Controller diagnostic', properties);
		return;
	}
	logger.info('Controller diagnostic', properties);
}
