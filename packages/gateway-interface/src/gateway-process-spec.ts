export type GatewayHealthCheck =
	| { readonly type: 'http'; readonly port: number; readonly path: string }
	| { readonly type: 'command'; readonly command: string };

/**
 * Everything about the process running inside the VM.
 * Retained by the running gateway handle for logs, health, restart.
 */
export interface GatewayProcessSpec {
	readonly bootstrapCommand: string;
	readonly startCommand: string;
	readonly healthCheck: GatewayHealthCheck;
	readonly guestListenPort: number;
	readonly logPath: string;
}
