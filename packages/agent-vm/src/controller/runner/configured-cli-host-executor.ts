import { spawn } from 'node:child_process';

import type { ConfiguredCliInput, ControllerExecutionOperation } from '@agent-vm/config-contracts';
import { resolveCliAllowanceTimeout, validateCliAllowanceInvocation } from '@agent-vm/tool-portal';

import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliOperation = Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;
export interface ConfiguredCliHostExecutionResult {
	readonly exitCode: number;
	readonly stderrSummary?: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
}

function resolveEnvironment(
	policy: ConfiguredCliOperation['executionTarget']['environment'],
): Readonly<Record<string, string>> {
	if (policy.kind === 'empty') return {};
	return Object.fromEntries(
		policy.names.flatMap((name) => {
			const value = process.env[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
}

function truncateUtf8(value: Buffer, maximumBytes: number): string {
	return value.subarray(0, maximumBytes).toString('utf8');
}

function fixedSafeStderrSummary(stderr: Buffer): string {
	try {
		const sanitized = stderr
			.toString('utf8')
			.replaceAll(/\b(?:token|password|secret|authorization)\s*[:=]\s*\S+/giu, '[REDACTED]')
			.replaceAll(/\b(?:Bearer|Basic)\s+\S+/giu, '[REDACTED]');
		return truncateUtf8(Buffer.from(sanitized, 'utf8'), 4_096);
	} catch {
		return 'Command stderr summary unavailable.';
	}
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
	readonly input: ConfiguredCliInput;
	readonly operation: ConfiguredCliOperation;
	readonly signal?: AbortSignal;
}): Promise<ConfiguredCliHostExecutionResult> {
	if (props.operation.executionTarget.kind !== 'controller_host') {
		throw new ConfiguredControllerExecutionError(
			'validation_failed',
			'Configured CLI target is not controller_host.',
		);
	}
	const validation = validateCliAllowanceInvocation({
		allowance: props.operation,
		input: props.input,
	});
	if (!validation.ok) {
		throw new ConfiguredControllerExecutionError('validation_failed', validation.error.message);
	}
	if (props.signal?.aborted === true) {
		throw new ConfiguredControllerExecutionError(
			'cancelled',
			'Configured CLI execution was cancelled before spawn.',
		);
	}

	const child = spawn(
		props.operation.executablePath,
		[...props.operation.mandatoryArgvPrefix, ...validation.argv],
		{
			cwd: props.operation.executionTarget.cwd,
			env: resolveEnvironment(props.operation.executionTarget.environment),
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
		const abortExecution = (): void =>
			settleFailure(
				new ConfiguredControllerExecutionError(
					'cancelled',
					'Configured CLI execution was cancelled.',
				),
			);

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
				kind: props.operation.timeout.kind,
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
			props.signal?.addEventListener('abort', abortExecution, { once: true });
			child.stdin.end(props.input.stdin);
		});
		child.stdout.on('data', (chunk: Buffer) => {
			try {
				const appended = appendBoundedChunk({
					chunks: stdoutChunks,
					chunk,
					maximumBytes: props.operation.output.stdoutMaxBytes,
					overflow: props.operation.output.overflow,
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
					maximumBytes: props.operation.output.stderrMaxBytes,
					overflow: props.operation.output.overflow,
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
				...(props.operation.output.modelVisibleStderr === 'fixed_safe_summary' &&
				stderr.byteLength > 0
					? { stderrSummary: fixedSafeStderrSummary(stderr) }
					: {}),
				stderrTruncated,
				stdout: Buffer.concat(stdoutChunks).toString('utf8'),
				stdoutTruncated,
			});
		});
	});
}
