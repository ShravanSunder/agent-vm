export class ControllerZoneNotFoundError extends Error {
	public constructor(zoneId: string) {
		super(`Unknown zone '${zoneId}'.`);
		this.name = 'ControllerZoneNotFoundError';
	}
}

export class ControllerZoneOperationUnsupportedError extends Error {
	public constructor(zoneId: string, operationName: string, gatewayType: string) {
		super(`Zone '${zoneId}' with gateway type '${gatewayType}' does not support ${operationName}.`);
		this.name = 'ControllerZoneOperationUnsupportedError';
	}
}

export class ControllerZoneRuntimeUnavailableError extends Error {
	public constructor(zoneId: string, lastError?: string) {
		super(
			lastError
				? `Gateway runtime for zone '${zoneId}' is unavailable. Last error: ${lastError}`
				: `Gateway runtime for zone '${zoneId}' is unavailable.`,
		);
		this.name = 'ControllerZoneRuntimeUnavailableError';
	}
}

export class ControllerZoneRuntimeStartError extends Error {
	public constructor(zoneId: string, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to start zone '${zoneId}': ${message}`, { cause });
		this.name = 'ControllerZoneRuntimeStartError';
	}
}
