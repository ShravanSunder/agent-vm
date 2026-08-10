import { getLogger } from '@logtape/logtape';

export type ControllerDiagnosticDomain =
	| 'gateway'
	| 'git'
	| 'heartbeat'
	| 'lease'
	| 'resource'
	| 'runtime';

type ControllerDiagnosticProperties = Readonly<Record<string, string>>;

function classifyDiagnosticEvent(message: string): 'diagnostic' | 'failure' {
	return /degrad|denied|error|fail|invalid|missing|refus|unable|unsafe/iu.test(message)
		? 'failure'
		: 'diagnostic';
}

function classifyDiagnosticFailure(message: string): string | undefined {
	if (/timeout|timed out/iu.test(message)) {
		return 'timeout';
	}
	if (/denied|refus|unsafe/iu.test(message)) {
		return 'rejected';
	}
	if (/missing|not found|unavailable/iu.test(message)) {
		return 'unavailable';
	}
	if (/degrad|error|fail|invalid|unable/iu.test(message)) {
		return 'failure';
	}
	return undefined;
}

export function createControllerDiagnosticProperties(
	message: string,
): ControllerDiagnosticProperties {
	const event = classifyDiagnosticEvent(message);
	const failureClass = classifyDiagnosticFailure(message);
	return {
		event,
		...(failureClass === undefined ? {} : { failureClass }),
	};
}

export function writeControllerDiagnostic(
	domain: ControllerDiagnosticDomain,
	message: string,
): void {
	getLogger(['agent-vm', 'controller', domain]).warn(
		'Controller diagnostic',
		createControllerDiagnosticProperties(message),
	);
}
