import {
	controllerConfiguredCliInputSchema,
	resolveConfiguredCliTimeout,
	type GatewayRuntimeControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import type {
	ControllerExecutionAuthorityBinding,
	ControllerExecutionResult,
} from '@agent-vm/controller-execution-contracts';
import type { ToolPortalApprovalPort } from '@agent-vm/tool-portal';

import type { StrictToolVmSshClient } from '../sandbox/strict-tool-vm-ssh-client.js';
import type { ControllerExecutionDispatchRequest } from './controller-execution-backend-port.js';

export interface ConfiguredCliToolVmAcquisitionPort {
	readonly acquire: (request: {
		readonly trustedContext: ControllerExecutionDispatchRequest['authority']['invocation']['trustedContext'];
	}) => Promise<
		| {
				readonly isCurrent: () => boolean;
				readonly kind: 'bound';
				readonly retireGroup: (reason: 'completed' | 'failed') => Promise<void>;
				readonly strictSshClient: StrictToolVmSshClient;
		  }
		| { readonly kind: 'not-bound' }
	>;
}

function notDispatchedResult(props: {
	readonly binding: ControllerExecutionAuthorityBinding;
	readonly code: 'cancelled' | 'capability_denied' | 'execution_failed';
	readonly message: string;
	readonly reason: 'runner-setup-failed' | 'stale-authority';
}): ControllerExecutionResult {
	return {
		binding: props.binding,
		certainty: 'proven',
		diagnostics: [],
		error: { code: props.code, message: props.message },
		kind: 'not-dispatched',
		reason: props.reason,
		retryClass: 'safe-before-dispatch',
	};
}

function ambiguousResult(
	binding: ControllerExecutionAuthorityBinding,
	message = 'Tool VM configured CLI dispatch state is unknown.',
): ControllerExecutionResult {
	return {
		binding,
		certainty: 'side-effects-and-termination-unknown',
		diagnostics: [],
		error: { code: 'execution_failed', message },
		kind: 'ambiguous',
		reason: 'dispatch-state-unknown',
		retryClass: 'forbidden',
	};
}

function truncateUtf8(value: Uint8Array, maximumBytes: number): string {
	const bounded = value.subarray(0, maximumBytes);
	const decoder = new TextDecoder('utf-8', { fatal: true });
	for (let removedBytes = 0; removedBytes <= 3; removedBytes += 1) {
		try {
			return decoder.decode(bounded.subarray(0, bounded.byteLength - removedBytes));
		} catch {
			// Only the final UTF-8 scalar can be partial.
		}
	}
	return '';
}

function safeStderrSummary(stderr: Uint8Array): string {
	const sanitized = new TextDecoder()
		.decode(stderr)
		.replaceAll(
			/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/gu,
			'[REDACTED]',
		)
		.replaceAll(
			/\b(?:api[-_ ]?key|authorization|cookie|password|private[-_ ]?key|refresh[-_ ]?token|secret|set-cookie|token)\s*[:=]\s*\S+/giu,
			'[REDACTED]',
		)
		.replaceAll(/\b(?:Bearer|Basic)\s+\S+/giu, '[REDACTED]');
	return truncateUtf8(new TextEncoder().encode(sanitized), 4_096);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

export async function executeConfiguredCliInToolVm(props: {
	readonly acquisitionPort: ConfiguredCliToolVmAcquisitionPort | undefined;
	readonly approvalPort: ToolPortalApprovalPort | undefined;
	readonly binding: ControllerExecutionAuthorityBinding;
	readonly input: ReturnType<typeof controllerConfiguredCliInputSchema.parse>;
	readonly operation: Extract<
		GatewayRuntimeControllerExecutionOperation,
		{ readonly kind: 'configured_cli'; readonly targetKind: 'tool_vm' }
	>;
	readonly request: ControllerExecutionDispatchRequest;
	readonly signal: AbortSignal | undefined;
}): Promise<ControllerExecutionResult> {
	if (isAborted(props.signal)) {
		return notDispatchedResult({
			binding: props.binding,
			code: 'cancelled',
			message: 'Tool VM configured CLI execution was cancelled before dispatch.',
			reason: 'stale-authority',
		});
	}
	if (props.acquisitionPort === undefined) {
		return notDispatchedResult({
			binding: props.binding,
			code: 'execution_failed',
			message: 'Tool VM configured CLI execution is unavailable.',
			reason: 'runner-setup-failed',
		});
	}
	const group = await props.acquisitionPort.acquire({
		trustedContext: props.request.authority.invocation.trustedContext,
	});
	if (group.kind === 'not-bound') {
		return notDispatchedResult({
			binding: props.binding,
			code: 'execution_failed',
			message: 'Tool VM configured CLI execution could not acquire the current Tool VM.',
			reason: 'runner-setup-failed',
		});
	}
	let retirementReason: 'completed' | 'failed' = 'failed';
	try {
		if (!group.isCurrent()) {
			return notDispatchedResult({
				binding: props.binding,
				code: 'capability_denied',
				message: 'Tool VM configured CLI lease authority is stale.',
				reason: 'stale-authority',
			});
		}
		try {
			await group.strictSshClient.connect();
		} catch {
			return notDispatchedResult({
				binding: props.binding,
				code: 'execution_failed',
				message: 'Tool VM configured CLI could not establish strict SSH.',
				reason: 'runner-setup-failed',
			});
		}
		if (isAborted(props.signal) || !group.isCurrent()) {
			return notDispatchedResult({
				binding: props.binding,
				code: isAborted(props.signal) ? 'cancelled' : 'capability_denied',
				message: isAborted(props.signal)
					? 'Tool VM configured CLI execution was cancelled before dispatch.'
					: 'Tool VM configured CLI lease authority changed before dispatch.',
				reason: 'stale-authority',
			});
		}
		const dispatchAuthority = props.request.authority.dispatchAuthority;
		if (dispatchAuthority.kind === 'controller-approval-reservation') {
			if (props.approvalPort === undefined) {
				return notDispatchedResult({
					binding: props.binding,
					code: 'capability_denied',
					message: 'Tool VM configured CLI approval arming is unavailable.',
					reason: 'runner-setup-failed',
				});
			}
			const armResult = await props.approvalPort.armDispatch({
				reservation: dispatchAuthority.reservation,
			});
			if (armResult.kind === 'not-dispatched') {
				return notDispatchedResult({
					binding: props.binding,
					code: 'capability_denied',
					message: 'Tool VM configured CLI approval is no longer current.',
					reason: 'stale-authority',
				});
			}
			if (
				armResult.kind === 'ambiguous' ||
				armResult.grant.backendKind !== 'controller_execution' ||
				armResult.grant.approvalId !== dispatchAuthority.reservation.approvalId ||
				armResult.grant.bindingRevision !== dispatchAuthority.reservation.bindingRevision ||
				armResult.grant.expiresAt !== dispatchAuthority.reservation.expiresAt ||
				armResult.grant.fingerprint !== dispatchAuthority.reservation.fingerprint ||
				armResult.grant.operationId !== dispatchAuthority.reservation.operationId ||
				armResult.grant.stablePrincipal !== dispatchAuthority.reservation.stablePrincipal ||
				JSON.stringify(armResult.grant.authorityContext) !==
					JSON.stringify(dispatchAuthority.reservation.authorityContext)
			) {
				return ambiguousResult(props.binding, 'Tool VM configured CLI approval arm is ambiguous.');
			}
		}
		if (isAborted(props.signal) || !group.isCurrent()) {
			return notDispatchedResult({
				binding: props.binding,
				code: isAborted(props.signal) ? 'cancelled' : 'capability_denied',
				message: isAborted(props.signal)
					? 'Tool VM configured CLI execution was cancelled after approval arming.'
					: 'Tool VM configured CLI lease authority changed after approval arming.',
				reason: 'stale-authority',
			});
		}
		const execution = await group.strictSshClient.execute({
			argv: [
				props.operation.executablePath,
				...props.operation.mandatoryArgvPrefix,
				...props.input.argv,
			],
			cwd: props.operation.workingDirectory,
			deadlineMilliseconds: resolveConfiguredCliTimeout({
				input: props.input,
				kind: props.operation.timeout.kind,
			}).resolvedTimeoutMs,
			output: {
				stderr: {
					captureBytes: props.operation.output.stderrMaxBytes,
					overflow: props.operation.output.overflow,
				},
				stdout: {
					captureBytes: props.operation.output.stdoutMaxBytes,
					overflow: props.operation.output.overflow,
				},
			},
			...(props.signal === undefined ? {} : { signal: props.signal }),
			...(props.input.stdin === undefined
				? {}
				: {
						maximumStdinBytes:
							props.operation.stdin.kind === 'none' ? 1 : props.operation.stdin.maxBytes,
						stdin: new TextEncoder().encode(props.input.stdin),
					}),
		});
		const stderrOverflow = execution.stderrTruncated === true;
		const stdoutOverflow = execution.stdoutTruncated === true;
		retirementReason = 'completed';
		return {
			binding: props.binding,
			certainty: 'proven',
			completion: 'succeeded',
			diagnostics: [],
			kind: 'completed',
			retryClass: 'forbidden',
			value: {
				exitCode: execution.exitCode,
				...(props.operation.output.modelVisibleStderr === 'fixed_safe_summary' &&
				execution.stderr.byteLength > 0
					? { stderrSummary: safeStderrSummary(execution.stderr) }
					: {}),
				stderrTruncated: stderrOverflow,
				stdout: truncateUtf8(execution.stdout, props.operation.output.stdoutMaxBytes),
				stdoutTruncated: stdoutOverflow,
			},
		};
	} catch {
		return ambiguousResult(props.binding);
	} finally {
		await group.retireGroup(retirementReason);
	}
}
