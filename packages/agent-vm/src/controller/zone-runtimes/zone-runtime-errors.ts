export class ControllerZoneNotFoundError extends Error {
	public readonly zoneId: string;

	public constructor(zoneId: string) {
		super(`Unknown zone '${zoneId}'.`);
		this.name = 'ControllerZoneNotFoundError';
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
	public readonly gatewayLifecycleErrorCode: GatewayLifecycleErrorCode | undefined;
	public readonly operationId: string | undefined;
	public readonly zoneId: string;

	public constructor(
		zoneId: string,
		cause: unknown,
		options: {
			readonly gatewayLifecycleErrorCode?: GatewayLifecycleErrorCode | undefined;
			readonly operationId?: string | undefined;
		} = {},
	) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to start zone '${zoneId}': ${message}`, { cause });
		this.name = 'ControllerZoneRuntimeStartError';
		this.gatewayLifecycleErrorCode = options.gatewayLifecycleErrorCode;
		this.operationId = options.operationId;
		this.zoneId = zoneId;
	}
}
import type { GatewayLifecycleErrorCode } from './gateway-zone-state-machine.js';
