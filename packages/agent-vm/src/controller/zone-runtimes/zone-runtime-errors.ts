export class ControllerZoneNotFoundError extends Error {
	public readonly zoneId: string;

	public constructor(zoneId: string) {
		super(`Unknown zone '${zoneId}'.`);
		this.name = 'ControllerZoneNotFoundError';
		this.zoneId = zoneId;
	}
}

export class ControllerZoneOperationUnsupportedError extends Error {
	public readonly gatewayType: string;
	public readonly operationName: string;
	public readonly zoneId: string;

	public constructor(zoneId: string, operationName: string, gatewayType: string) {
		super(`Zone '${zoneId}' with gateway type '${gatewayType}' does not support ${operationName}.`);
		this.name = 'ControllerZoneOperationUnsupportedError';
		this.gatewayType = gatewayType;
		this.operationName = operationName;
		this.zoneId = zoneId;
	}
}

export class ControllerZoneConfigurationError extends Error {
	public readonly zoneId: string;

	public constructor(zoneId: string, message: string) {
		super(message);
		this.name = 'ControllerZoneConfigurationError';
		this.zoneId = zoneId;
	}
}

export class ControllerZoneTaskNotFoundError extends Error {
	public readonly taskId: string;
	public readonly zoneId: string;

	public constructor(zoneId: string, taskId: string) {
		super(`Task '${taskId}' is not active for zone '${zoneId}'.`);
		this.name = 'ControllerZoneTaskNotFoundError';
		this.zoneId = zoneId;
		this.taskId = taskId;
	}
}

export class ControllerZoneTaskNotReadyError extends Error {
	public readonly taskId: string;
	public readonly zoneId: string;

	public constructor(zoneId: string, taskId: string, message: string) {
		super(message);
		this.name = 'ControllerZoneTaskNotReadyError';
		this.zoneId = zoneId;
		this.taskId = taskId;
	}
}

export class ControllerZoneRuntimeUnavailableError extends Error {
	public readonly lastError: string | undefined;
	public readonly zoneId: string;

	public constructor(zoneId: string, lastError?: string) {
		super(
			lastError
				? `Gateway runtime for zone '${zoneId}' is unavailable. Last error: ${lastError}`
				: `Gateway runtime for zone '${zoneId}' is unavailable.`,
		);
		this.name = 'ControllerZoneRuntimeUnavailableError';
		this.lastError = lastError;
		this.zoneId = zoneId;
	}
}

export class ControllerZoneRuntimeStartError extends Error {
	public readonly zoneId: string;

	public constructor(zoneId: string, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to start zone '${zoneId}': ${message}`, { cause });
		this.name = 'ControllerZoneRuntimeStartError';
		this.zoneId = zoneId;
	}
}
