import { spawn } from 'node:child_process';

import type {
	ConfiguredCliInput,
	EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import {
	evaluateCliAllowanceInvocation,
	resolveCliAllowanceTimeout,
} from '@agent-vm/tool-portal/cli-allowances';

import {
	configuredCliAuthorizedEvaluationsEqual,
	type ConfiguredCliAuthorizedOperation,
} from './configured-cli-authorization.js';
import { resolveConfiguredCliEnvironment } from './configured-cli-environment.js';
import { fixedSafeConfiguredCliStderrSummary } from './configured-cli-output.js';
import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ kind: 'configured_cli' }
>;
export interface ConfiguredCliHostExecutionResult {
	readonly exitCode: number;
	readonly stderrSummary?: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
}

function appendBoundedChunk(props: {
	readonly chunks: Buffer[];
	readonly chunk: Buffer;
	readonly maximumBytes: number;
	readonly overflow: 'fail' | 'truncate';
	readonly streamName: 'stderr' | 'stdout';
	readonly totalBytes: number;
}): { readonly nextTotalBytes: number; readonly truncated: boolean } {
	const nextTotalBytes = props.totalBytes + props.chunk.byteLength;
	if (nextTotalBytes <= props.maximumBytes) {
		props.chunks.push(props.chunk);
		return { nextTotalBytes, truncated: false };
	}
	if (props.overflow === 'fail') {
		throw new ConfiguredControllerExecutionError(
			'execution_failed',
			`Configured CLI ${props.streamName} exceeded its configured bound.`,
		);
	}
	const remainingBytes = Math.max(0, props.maximumBytes - props.totalBytes);
	if (remainingBytes > 0) props.chunks.push(props.chunk.subarray(0, remainingBytes));
	return { nextTotalBytes, truncated: true };
}

export async function executeConfiguredCliOnControllerHost(props: {
	readonly authorization: ConfiguredCliAuthorizedOperation;
	readonly input: ConfiguredCliInput;
	readonly operation: ConfiguredCliOperation;
	readonly reloadAuthorization: () => Promise<ConfiguredCliAuthorizedOperation>;
	readonly signal?: AbortSignal;
}): Promise<ConfiguredCliHostExecutionResult> {
	if (props.operation.executionTarget.kind !== 'controller_host') {
		throw new ConfiguredControllerExecutionError(
			'validation_failed',
			'Configured CLI target is not controller_host.',
		);
	}
	const currentAuthorization = await props.reloadAuthorization();
	if (
		!configuredCliAuthorizedEvaluationsEqual(
			props.authorization.evaluation,
			currentAuthorization.evaluation,
		) ||
		currentAuthorization.operation.executionTarget.kind !== 'controller_host'
	) {
		throw new ConfiguredControllerExecutionError(
			'not_dispatched',
			'Configured CLI authority changed before host process creation.',
		);
	}
	const currentOperation = currentAuthorization.operation;
	if (currentOperation.executionTarget.kind !== 'controller_host') {
		throw new ConfiguredControllerExecutionError(
			'not_dispatched',
			'Configured CLI target changed before host process creation.',
		);
	}
	const validation = evaluateCliAllowanceInvocation({
		allowance: currentOperation,
		baseline: 'without_approval',
		input: props.input,
	});
	if (!validation.ok) {
		throw new ConfiguredControllerExecutionError('validation_failed', validation.error.message);
	}
	if (props.signal?.aborted === true) {
		throw new ConfiguredControllerExecutionError(
			'not_dispatched',
			'Configured CLI execution was cancelled before spawn.',
		);
	}

	const child = spawn(
		currentOperation.executablePath,
		[...currentOperation.mandatoryArgvPrefix, ...validation.argv],
		{
			cwd: currentOperation.executionTarget.cwd,
			env: resolveConfiguredCliEnvironment(currentOperation.executionTarget.environment),
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		},
	);
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let stdoutTruncated = false;
	let stderrTruncated = false;
	let commandTimer: ReturnType<typeof setTimeout> | undefined;

	return await new Promise<ConfiguredCliHostExecutionResult>((resolve, reject) => {
		let settled = false;
		const settleFailure = (error: Error): void => {
			if (settled) return;
			settled = true;
			if (commandTimer !== undefined) clearTimeout(commandTimer);
			props.signal?.removeEventListener('abort', abortExecution);
			child.kill('SIGKILL');
			reject(error);
		};
		const abortExecution = (): void => {
			const reason = props.signal?.reason;
			settleFailure(
				reason instanceof ConfiguredControllerExecutionError
					? reason
					: new ConfiguredControllerExecutionError(
							'cancelled',
							'Configured CLI execution was cancelled.',
						),
			);
		};
		props.signal?.addEventListener('abort', abortExecution, { once: true });
		if (props.signal?.aborted === true) {
			abortExecution();
			return;
		}

		child.once('error', () =>
			settleFailure(
				new ConfiguredControllerExecutionError(
					'not_dispatched',
					'Configured CLI process could not be started.',
				),
			),
		);
		child.once('spawn', () => {
			const timeout = resolveCliAllowanceTimeout({
				input: props.input,
				kind: currentOperation.timeout.kind,
			});
			commandTimer = setTimeout(
				() =>
					settleFailure(
						new ConfiguredControllerExecutionError(
							'timeout',
							'Configured CLI execution timed out.',
						),
					),
				timeout.resolvedTimeoutMs,
			);
			child.stdin.end(props.input.stdin);
		});
		child.stdout.on('data', (chunk: Buffer) => {
			try {
				const appended = appendBoundedChunk({
					chunks: stdoutChunks,
					chunk,
					maximumBytes: currentOperation.output.stdoutMaxBytes,
					overflow: currentOperation.output.overflow,
					streamName: 'stdout',
					totalBytes: stdoutBytes,
				});
				stdoutBytes = appended.nextTotalBytes;
				stdoutTruncated ||= appended.truncated;
			} catch (error) {
				settleFailure(error instanceof Error ? error : new Error(String(error)));
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			try {
				const appended = appendBoundedChunk({
					chunks: stderrChunks,
					chunk,
					maximumBytes: currentOperation.output.stderrMaxBytes,
					overflow: currentOperation.output.overflow,
					streamName: 'stderr',
					totalBytes: stderrBytes,
				});
				stderrBytes = appended.nextTotalBytes;
				stderrTruncated ||= appended.truncated;
			} catch (error) {
				settleFailure(error instanceof Error ? error : new Error(String(error)));
			}
		});
		child.once('close', (exitCode) => {
			if (settled) return;
			settled = true;
			if (commandTimer !== undefined) clearTimeout(commandTimer);
			props.signal?.removeEventListener('abort', abortExecution);
			const stderr = Buffer.concat(stderrChunks);
			resolve({
				exitCode: exitCode ?? -1,
				...(currentOperation.output.modelVisibleStderr === 'fixed_safe_summary' &&
				stderr.byteLength > 0
					? { stderrSummary: fixedSafeConfiguredCliStderrSummary(stderr) }
					: {}),
				stderrTruncated,
				stdout: Buffer.concat(stdoutChunks).toString('utf8'),
				stdoutTruncated,
			});
		});
	});
}
