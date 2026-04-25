import type { VerificationCommand } from '../validation-runner/verification-runner.js';
import { runVerification } from '../validation-runner/verification-runner.js';
import type { ToolDefinition } from '../work-executor/executor-interface.js';

export interface BuildValidationToolProps {
	readonly commands: readonly VerificationCommand[];
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly rawLogDir: string;
	readonly attemptLabelPrefix: string;
}

const DESCRIPTION =
	'Runs the project-configured validation commands in sequence and returns their results. Each command writes a full raw stdout/stderr log.';

export function buildValidationTool(props: BuildValidationToolProps): ToolDefinition {
	let callCount = 0;

	return {
		name: 'run_validation',
		description: DESCRIPTION,
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		async execute(_params: Record<string, unknown>) {
			callCount += 1;
			return await runVerification({
				commands: props.commands,
				cwd: props.cwd,
				timeoutMs: props.timeoutMs,
				rawLogDir: props.rawLogDir,
				attemptLabel: `${props.attemptLabelPrefix}-call-${String(callCount)}`,
			});
		},
	};
}
