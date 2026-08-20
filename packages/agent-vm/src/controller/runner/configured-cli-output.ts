import type { ControllerExecutionOperation } from '@agent-vm/config-contracts';

import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliOutputPolicy = Extract<
	ControllerExecutionOperation,
	{ readonly kind: 'configured_cli' }
>['output'];

function truncateUtf8(value: Uint8Array, maximumBytes: number): string {
	return Buffer.from(value).subarray(0, maximumBytes).toString('utf8');
}

export function fixedSafeConfiguredCliStderrSummary(stderr: Uint8Array): string {
	try {
		const sanitized = Buffer.from(stderr)
			.toString('utf8')
			.replaceAll(/\b(?:token|password|secret|authorization)\s*[:=]\s*\S+/giu, '[REDACTED]')
			.replaceAll(/\b(?:Bearer|Basic)\s+\S+/giu, '[REDACTED]');
		return truncateUtf8(Buffer.from(sanitized, 'utf8'), 4_096);
	} catch {
		return 'Command stderr summary unavailable.';
	}
}

export function projectConfiguredCliBufferedOutput(props: {
	readonly exitCode: number;
	readonly output: ConfiguredCliOutputPolicy;
	readonly stderr: Uint8Array;
	readonly stdout: Uint8Array;
}): {
	readonly exitCode: number;
	readonly stderrSummary?: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
} {
	const stderrOverflow = props.stderr.byteLength > props.output.stderrMaxBytes;
	const stdoutOverflow = props.stdout.byteLength > props.output.stdoutMaxBytes;
	if (props.output.overflow === 'fail' && (stderrOverflow || stdoutOverflow)) {
		throw new ConfiguredControllerExecutionError(
			'execution_failed',
			'Configured CLI output exceeded its configured bound.',
		);
	}
	const boundedStderr = props.stderr.subarray(0, props.output.stderrMaxBytes);
	const boundedStdout = props.stdout.subarray(0, props.output.stdoutMaxBytes);
	return {
		exitCode: props.exitCode,
		...(props.output.modelVisibleStderr === 'fixed_safe_summary' && boundedStderr.byteLength > 0
			? { stderrSummary: fixedSafeConfiguredCliStderrSummary(boundedStderr) }
			: {}),
		stderrTruncated: stderrOverflow,
		stdout: Buffer.from(boundedStdout).toString('utf8'),
		stdoutTruncated: stdoutOverflow,
	};
}
