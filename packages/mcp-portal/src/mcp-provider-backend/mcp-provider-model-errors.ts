import type { PortalError, PortalErrorCode, SafeDiagnostic } from '@agent-vm/agent-portal-sdk';

export function portalErrorFromUnknown(error: unknown): PortalError {
	const errorRecord = isRecord(error) ? error : {};
	const upstream = isRecord(errorRecord.upstream) ? errorRecord.upstream : {};
	const failureClass = upstream.failureClass;
	if (failureClass === 'authentication') {
		return modelSafeRemoteProviderError({
			code: 'not_authorized',
			message:
				'Remote capability authentication failed. Ask the operator to verify its provider credential.',
			upstream,
		});
	}
	if (failureClass === 'authorization') {
		return modelSafeRemoteProviderError({
			code: 'not_authorized',
			message: 'Remote capability provider denied access. Ask the operator to verify its access.',
			upstream,
		});
	}
	if (failureClass === 'invalid_request') {
		return modelSafeRemoteProviderError({
			code: 'validation_failed',
			message: 'Remote capability provider rejected the request. Check the capability arguments.',
			upstream,
		});
	}
	if (failureClass === 'rate_limit') {
		return modelSafeRemoteProviderError({
			code: 'provider_unavailable',
			message: 'Remote capability provider is rate limited. Retry later.',
			retryable: true,
			upstream,
		});
	}
	if (failureClass === 'provider_error') {
		return modelSafeRemoteProviderError({
			code: 'provider_unavailable',
			message: 'Remote capability provider failed. Retry later.',
			retryable: true,
			upstream,
		});
	}
	if (failureClass === 'tool_error') {
		const providerErrorMessage =
			typeof upstream.providerErrorMessage === 'string' &&
			upstream.providerErrorMessage.trim().length > 0
				? upstream.providerErrorMessage.trim()
				: undefined;
		return modelSafeRemoteProviderError({
			code: 'execution_failed',
			message:
				providerErrorMessage === undefined
					? 'Remote capability reported an execution error.'
					: `Remote capability reported an execution error: ${providerErrorMessage}`,
			upstream,
		});
	}
	const codeValue = errorRecord.code ?? errorRecord.kind;
	const code = typeof codeValue === 'string' ? safeCode(codeValue) : 'execution_failed';
	const validationMessage =
		code === 'validation_failed' ? validationMessageFromErrorRecord(errorRecord) : undefined;
	return {
		code,
		message: validationMessage ?? safeErrorMessageForCode(code),
		safeDiagnostic: safeDiagnosticForCode(code),
	};
}

export function safeDiagnosticForCode(code: string): SafeDiagnostic {
	const diagnosticCode = safeDiagnosticCode(code);
	return {
		code: diagnosticCode,
		level: diagnosticCode === 'approval_required' ? 'warn' : 'error',
		safeMessage: safeErrorMessageForCode(diagnosticCode),
	};
}

function validationMessageFromErrorRecord(
	errorRecord: Readonly<Record<string, unknown>>,
): string | undefined {
	if (!Array.isArray(errorRecord.issues)) {
		return undefined;
	}
	const issueMessages = errorRecord.issues.slice(0, 5).flatMap((issue): readonly string[] => {
		if (!isRecord(issue) || !Array.isArray(issue.path) || typeof issue.message !== 'string') {
			return [];
		}
		const path = issue.path
			.filter(
				(pathPart): pathPart is number | string =>
					typeof pathPart === 'number' || typeof pathPart === 'string',
			)
			.map((pathPart) => String(pathPart))
			.join('.');
		const details = [
			typeof issue.expected === 'string' ? `expected ${issue.expected}` : undefined,
			Array.isArray(issue.keys) && issue.keys.every((key) => typeof key === 'string')
				? `unrecognized keys ${issue.keys.join(', ')}`
				: undefined,
			issue.message,
		].filter((detail): detail is string => detail !== undefined);
		return [`${path.length === 0 ? '(root)' : path}: ${details.join('; ')}`];
	});
	if (issueMessages.length === 0) {
		return undefined;
	}
	const hiddenIssueCount = errorRecord.issues.length - issueMessages.length;
	const suffix =
		hiddenIssueCount > 0
			? ` | ${String(hiddenIssueCount)} more validation issue(s) omitted; describe the capability for its exact schema.`
			: '';
	return `Input validation failed: ${issueMessages.join(' | ')}${suffix}`;
}

function modelSafeRemoteProviderError(props: {
	readonly code: PortalErrorCode;
	readonly message: string;
	readonly retryable?: boolean;
	readonly upstream: Readonly<Record<string, unknown>>;
}): PortalError {
	const safeParams: Record<string, string | number | boolean> = {};
	if (typeof props.upstream.failureClass === 'string') {
		safeParams.failureClass = props.upstream.failureClass;
	}
	if (
		typeof props.upstream.httpStatusCode === 'number' &&
		Number.isInteger(props.upstream.httpStatusCode) &&
		props.upstream.httpStatusCode >= 100 &&
		props.upstream.httpStatusCode <= 599
	) {
		safeParams.httpStatusCode = props.upstream.httpStatusCode;
	}
	if (typeof props.upstream.namespace === 'string') {
		safeParams.namespace = props.upstream.namespace;
	}
	if (typeof props.upstream.phase === 'string') {
		safeParams.phase = props.upstream.phase;
	}
	return {
		code: props.code,
		message: props.message,
		...(props.retryable === undefined ? {} : { retryable: props.retryable }),
		safeDiagnostic: {
			code: safeDiagnosticCode(props.code),
			level: 'error',
			safeMessage: props.message,
			...(Object.keys(safeParams).length === 0 ? {} : { safeParams }),
		},
	};
}

function safeErrorMessageForCode(code: string): string {
	const diagnosticCode = safeDiagnosticCode(code);
	if (diagnosticCode === 'approval_required') {
		return 'Operator approval is required.';
	}
	if (diagnosticCode === 'capability_denied') {
		return 'Requested capability is not allowed.';
	}
	if (diagnosticCode === 'validation_failed') {
		return 'Capability input did not match the expected schema.';
	}
	if (diagnosticCode === 'provider_unavailable') {
		return 'Capability provider is unavailable.';
	}
	if (diagnosticCode === 'timeout') {
		return 'Capability execution timed out.';
	}
	if (diagnosticCode === 'cancelled') {
		return 'Capability execution was cancelled.';
	}
	return 'Capability execution failed.';
}

function safeDiagnosticCode(code: string): SafeDiagnostic['code'] {
	if (code === 'approval_required') {
		return 'approval_required';
	}
	if (
		code === 'capability_denied' ||
		code === 'unknown_or_denied_tool' ||
		code === 'call_blocked'
	) {
		return 'capability_denied';
	}
	if (
		code === 'invalid_portal_input' ||
		code === 'input_validation' ||
		code === 'validation_failed'
	) {
		return 'validation_failed';
	}
	if (code === 'timeout') {
		return 'timeout';
	}
	if (code === 'cancelled') {
		return 'cancelled';
	}
	if (
		code === 'provider_unavailable' ||
		code === 'namespace_unavailable' ||
		code === 'upstream_discovery_failed' ||
		code === 'upstream_mcp_failed'
	) {
		return 'provider_unavailable';
	}
	return 'execution_failed';
}

function safeCode(code: string): PortalErrorCode {
	if (
		code === 'invalid_request' ||
		code === 'not_found' ||
		code === 'not_authorized' ||
		code === 'approval_required' ||
		code === 'capability_denied' ||
		code === 'validation_failed' ||
		code === 'provider_unavailable' ||
		code === 'execution_failed' ||
		code === 'cancelled' ||
		code === 'timeout'
	) {
		return code;
	}
	const diagnosticCode = safeDiagnosticCode(code);
	if (
		diagnosticCode === 'provider_unavailable' ||
		diagnosticCode === 'capability_denied' ||
		diagnosticCode === 'approval_required' ||
		diagnosticCode === 'validation_failed' ||
		diagnosticCode === 'execution_failed' ||
		diagnosticCode === 'timeout' ||
		diagnosticCode === 'cancelled'
	) {
		return diagnosticCode;
	}
	return 'execution_failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
