export type ConfiguredControllerExecutionErrorCode =
	| 'cancelled'
	| 'execution_failed'
	| 'not_dispatched'
	| 'timeout'
	| 'validation_failed';

export class ConfiguredControllerExecutionError extends Error {
	public constructor(
		public readonly code: ConfiguredControllerExecutionErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ConfiguredControllerExecutionError';
	}
}
