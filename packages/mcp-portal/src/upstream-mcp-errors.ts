import type {
	NormalizedUpstreamMcpServer,
	UpstreamMcpTransportKind,
} from './upstream-mcp-client-runtime.js';

export type UpstreamMcpFailurePhase = 'call_tool' | 'connect' | 'list_tools';

export type UpstreamMcpFailureClass =
	| 'authentication'
	| 'authorization'
	| 'invalid_request'
	| 'provider_error'
	| 'rate_limit'
	| 'tool_error';

export type UpstreamMcpTransportSummary =
	| {
			readonly argCount: number;
			readonly command: string;
			readonly cwd?: string;
			readonly kind: 'stdio';
	  }
	| {
			readonly kind: Exclude<UpstreamMcpTransportKind, 'auto-http' | 'stdio'>;
			readonly url: string;
	  };

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

export class UpstreamMcpError extends Error {
	readonly details: UpstreamMcpFailureDetails;

	constructor(details: UpstreamMcpFailureDetails) {
		super(formatUpstreamMcpFailureMessage(details));
		this.name = 'UpstreamMcpError';
		this.details = details;
	}
}

export function messageFromUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	return String(error);
}

export function isUpstreamMcpError(error: unknown): error is UpstreamMcpError {
	return error instanceof UpstreamMcpError;
}

export function transportSummaryFromServer(
	server: NormalizedUpstreamMcpServer,
	attemptTransport?: Exclude<UpstreamMcpTransportKind, 'auto-http'>,
): UpstreamMcpTransportSummary {
	if (server.transport === 'stdio') {
		return {
			argCount: server.args?.length ?? 0,
			command: server.command,
			...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
			kind: 'stdio',
		};
	}

	return {
		kind: attemptTransport === 'sse' ? 'sse' : 'streamable-http',
		url: sanitizeRemoteMcpUrlForDiagnostics(server.url),
	};
}

export function sanitizeRemoteMcpUrlForDiagnostics(url: string): string {
	try {
		const parsedUrl = new URL(url);
		parsedUrl.username = '';
		parsedUrl.password = '';
		parsedUrl.search = '';
		parsedUrl.hash = '';
		return parsedUrl.toString();
	} catch {
		return '<invalid-url>';
	}
}

function hintForFailure(
	details: Omit<UpstreamMcpFailureDetails, 'hint' | 'kind'>,
): string | undefined {
	if (details.phase === 'connect' && details.transport.kind === 'stdio') {
		return 'stdio MCP command failed before tool discovery; verify command, package bin name, gateway PATH, and arg count.';
	}
	if (details.phase === 'connect' && details.transport.kind !== 'stdio') {
		return 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.';
	}
	if (details.phase === 'list_tools') {
		return 'MCP provider connected but tool discovery failed; run agent-vm validate --mcp-live for the configured namespace.';
	}
	if (details.phase === 'call_tool') {
		return 'MCP provider accepted discovery but the tool call failed; inspect the tool arguments and upstream provider response.';
	}
	return undefined;
}

export function createUpstreamMcpError(
	details: Omit<UpstreamMcpFailureDetails, 'hint' | 'kind'>,
): UpstreamMcpError {
	const hint = hintForFailure(details);
	return new UpstreamMcpError({
		...details,
		...(hint !== undefined ? { hint } : {}),
		kind: 'upstream_mcp_failed',
	});
}

export function upstreamMcpFailureDetailsFromUnknown(
	error: unknown,
): UpstreamMcpFailureDetails | null {
	return isUpstreamMcpError(error) ? error.details : null;
}

export function formatUpstreamMcpFailureMessage(details: UpstreamMcpFailureDetails): string {
	const toolSuffix = details.toolName === undefined ? '' : ` ${details.toolName}`;
	return `${details.namespace}: ${details.phase}${toolSuffix} failed: ${details.causeMessage}`;
}
