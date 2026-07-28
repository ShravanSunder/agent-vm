export interface GatewayRuntimeStartupRetryPolicy {
	readonly deadlineMs: number;
	readonly intervalMs: number;
	readonly maxAttempts: number;
}

export const DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY = Object.freeze({
	deadlineMs: 5_000,
	intervalMs: 100,
	maxAttempts: 50,
}) satisfies GatewayRuntimeStartupRetryPolicy;

export interface GatewayRuntimeStartupRetryScheduler {
	readonly now: () => number;
	readonly wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export type GatewayRuntimeStartupUnavailableKind = 'socket-absent' | 'socket-refused';

/** A pre-handshake socket publication race that is safe to retry within the startup budget. */
export class GatewayRuntimeStartupUnavailableError extends Error {
	readonly code = 'startup-unavailable';
	readonly kind: GatewayRuntimeStartupUnavailableKind;

	constructor(kind: GatewayRuntimeStartupUnavailableKind, options: ErrorOptions = {}) {
		super(`Gateway runtime startup socket is unavailable: ${kind}.`, options);
		this.name = 'GatewayRuntimeStartupUnavailableError';
		this.kind = kind;
	}
}

export const defaultGatewayRuntimeStartupRetryScheduler: GatewayRuntimeStartupRetryScheduler = {
	now: () => performance.now(),
	wait: async (delayMs, signal): Promise<void> => {
		if (signal.aborted) throw signal.reason;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				resolve();
			}, delayMs);
			const onAbort = (): void => {
				cleanup();
				reject(signal.reason);
			};
			const cleanup = (): void => {
				clearTimeout(timeout);
				signal.removeEventListener('abort', onAbort);
			};
			signal.addEventListener('abort', onAbort, { once: true });
		});
	},
};
