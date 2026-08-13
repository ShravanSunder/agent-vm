import { getLogger } from '@logtape/logtape';

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

export type ControllerDiagnosticDescriptor =
	| {
			readonly event: ControllerDiagnosticEvent;
			readonly level: 'info';
	  }
	| {
			readonly event: ControllerDiagnosticEvent;
			readonly failureClass: ControllerDiagnosticFailureClass;
			readonly level: 'warning';
	  };

type ControllerDiagnosticProperties = Readonly<Record<string, string>>;

export function createControllerDiagnosticProperties(
	descriptor: ControllerDiagnosticDescriptor,
): ControllerDiagnosticProperties {
	return descriptor.level === 'warning'
		? { event: descriptor.event, failureClass: descriptor.failureClass }
		: { event: descriptor.event };
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
