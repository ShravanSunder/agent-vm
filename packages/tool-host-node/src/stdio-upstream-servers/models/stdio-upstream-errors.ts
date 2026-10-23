import type { UpstreamMcpTransportKind } from '#node-host/stdio-upstream-servers/models/stdio-upstream-protocol';
export type UpstreamMcpFailurePhase = 'call_tool' | 'connect' | 'list_tools';

export type UpstreamMcpFailureClass =
	| 'authentication'
	| 'authorization'
	| 'invalid_request'
	| 'provider_error'
	| 'rate_limit'
	| 'tool_error';

export interface UpstreamMcpTransportSummary {
	readonly argCount: number;
	readonly command: string;
	readonly cwd?: string;
	readonly kind: 'stdio';
}

export interface UpstreamMcpFailureDetails {
	readonly attemptTransport?: Exclude<UpstreamMcpTransportKind, 'auto-http'>;
	readonly causeMessage: string;
	readonly elapsedMs: number;
	readonly failureClass?: UpstreamMcpFailureClass;
	readonly hint?: string;
	readonly httpStatusCode?: number;
	readonly kind: 'upstream_mcp_failed';
	readonly namespace: string;
	readonly operation: string;
	readonly phase: UpstreamMcpFailurePhase;
	readonly providerErrorMessage?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport: UpstreamMcpTransportSummary;
}
