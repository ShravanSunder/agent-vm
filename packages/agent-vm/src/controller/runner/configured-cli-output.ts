import {
	ConfiguredCliOutputOverflowError,
	fixedSafeConfiguredCliStderrSummary,
	projectConfiguredCliBufferedOutput as projectSharedConfiguredCliBufferedOutput,
	type ControllerExecutionOperation,
} from '@agent-vm/config-contracts';

import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliOutputPolicy = Extract<
	ControllerExecutionOperation,
	{ readonly kind: 'configured_cli' }
>['output'];

export { fixedSafeConfiguredCliStderrSummary };

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
	try {
		const result = projectSharedConfiguredCliBufferedOutput(props);
		return {
			exitCode: result.exitCode,
			...(result.stderrSummary === undefined ? {} : { stderrSummary: result.stderrSummary }),
			stderrTruncated: result.stderrTruncated,
			stdout: result.stdout,
			stdoutTruncated: result.stdoutTruncated,
		};
	} catch (error) {
		if (error instanceof ConfiguredCliOutputOverflowError) {
			throw new ConfiguredControllerExecutionError('execution_failed', error.message);
		}
		throw error;
	}
}
