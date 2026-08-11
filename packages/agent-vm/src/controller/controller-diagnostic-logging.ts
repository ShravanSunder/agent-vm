import { getLogger } from '@logtape/logtape';

export type ControllerDiagnosticDomain =
	| 'gateway'
	| 'git'
	| 'heartbeat'
	| 'lease'
	| 'resource'
	| 'runtime';

type ControllerDiagnosticProperties = Readonly<Record<string, string>>;
const maxDiagnosticSummaryLength = 256;
const unsafeDiagnosticContentPattern =
	/https?:\/\/|op:\/\/|authorization|cookie|password|private\s+key|prompt|response|secret|token|(?:^|[\s'"])\/[^\s'"]+/iu;

function classifyDiagnosticEvent(message: string): 'diagnostic' | 'failure' {
	return /degrad|denied|error|fail|invalid|missing|refus|unable|unsafe/iu.test(message)
		? 'failure'
		: 'diagnostic';
}

function classifyDiagnosticFailure(message: string): string | undefined {
	if (/timeout|timed out/iu.test(message)) {
		return 'timeout';
	}
	if (/ECONNREFUSED|connection refused|unavailable|missing|not found/iu.test(message)) {
		return 'unavailable';
	}
	if (/denied|refus|unsafe/iu.test(message)) {
		return 'rejected';
	}
	if (/degrad|error|fail|invalid|unable/iu.test(message)) {
		return 'failure';
	}
	return undefined;
}

function createSafeDiagnosticSummary(message: string): string | undefined {
	const normalized = message.replace(/[\r\n\t]/gu, ' ').trim();
	if (normalized.length === 0 || unsafeDiagnosticContentPattern.test(normalized)) {
		return undefined;
	}
	return normalized.slice(0, maxDiagnosticSummaryLength);
}

export function createControllerDiagnosticProperties(
	message: string,
): ControllerDiagnosticProperties {
	const event = classifyDiagnosticEvent(message);
	const failureClass = classifyDiagnosticFailure(message);
	const errorSummary = createSafeDiagnosticSummary(message);
	return {
		event,
		...(failureClass === undefined ? {} : { failureClass }),
		...(errorSummary === undefined ? {} : { errorSummary }),
	};
}

export function writeControllerDiagnostic(
	domain: ControllerDiagnosticDomain,
	message: string,
): void {
	const properties = createControllerDiagnosticProperties(message);
	const logger = getLogger(['agent-vm', 'controller', domain]);
	if (properties.event === 'failure') {
		logger.warn('Controller diagnostic', properties);
		return;
	}
	logger.info('Controller diagnostic', properties);
}
