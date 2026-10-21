export interface PortalDiscoveryFailure {
	readonly causeMessage?: string;
	readonly elapsedMs?: number;
	readonly hint?: string;
	readonly kind: string;
	readonly message: string;
	readonly namespace: string;
	readonly operation?: string;
	readonly phase?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport?: unknown;
}
