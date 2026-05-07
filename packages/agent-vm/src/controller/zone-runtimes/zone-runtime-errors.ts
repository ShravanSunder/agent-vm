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

export class ControllerZoneAdminAuthError extends Error {
	public readonly code: 'zone-admin-auth-denied' | 'zone-admin-auth-required';
	public readonly httpStatus: 401 | 403;
	public readonly zoneId: string;

	public constructor(options: {
		readonly code: 'zone-admin-auth-denied' | 'zone-admin-auth-required';
		readonly httpStatus: 401 | 403;
		readonly zoneId: string;
	}) {
		super(
			options.code === 'zone-admin-auth-required'
				? `Zone '${options.zoneId}' requires admin authorization.`
				: `Zone '${options.zoneId}' rejected admin authorization.`,
		);
		this.name = 'ControllerZoneAdminAuthError';
		this.code = options.code;
		this.httpStatus = options.httpStatus;
		this.zoneId = options.zoneId;
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
	public readonly taskId: string | null;
	public readonly zoneId: string;

	public constructor(zoneId: string, taskId: string | null, message: string) {
		super(message);
		this.name = 'ControllerZoneTaskNotReadyError';
		this.zoneId = zoneId;
		this.taskId = taskId;
	}
}

export class ControllerZoneWorkerCloseError extends Error {
	public readonly body: string;
	public readonly httpStatus: number;
	public readonly taskId: string;
	public readonly zoneId: string;

	public constructor(options: {
		readonly body: string;
		readonly httpStatus: number;
		readonly taskId: string;
		readonly zoneId: string;
	}) {
		super(`worker close returned HTTP ${String(options.httpStatus)} for task '${options.taskId}'`);
		this.name = 'ControllerZoneWorkerCloseError';
		this.body = options.body;
		this.httpStatus = options.httpStatus;
		this.taskId = options.taskId;
		this.zoneId = options.zoneId;
	}
}

export class ControllerZoneWorkerCloseAggregateError extends AggregateError {
	public readonly failures: readonly ControllerZoneWorkerCloseError[];
	public readonly zoneId: string;

	public constructor(zoneId: string, failures: readonly ControllerZoneWorkerCloseError[]) {
		super(
			failures,
			`Failed to close ${String(failures.length)} worker task(s) for zone '${zoneId}'.`,
		);
		this.name = 'ControllerZoneWorkerCloseAggregateError';
		this.zoneId = zoneId;
		this.failures = failures;
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
