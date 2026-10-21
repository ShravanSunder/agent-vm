import type { JsonObject } from '@agent-collaboration/tool-access/contracts';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Progress, Tool } from '@modelcontextprotocol/sdk/types.js';
export type UpstreamMcpTransportKind = 'stdio';
export interface NormalizedUpstreamMcpServer {
	readonly namespace: string;
	readonly transport: 'stdio';
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly connectionTimeoutMs?: number;
}

export interface ListToolsCall {
	readonly agentScopeId: string;
	readonly namespace: string;
}

export interface UpstreamToolCall {
	readonly arguments: JsonObject;
	readonly agentScopeId: string;
	readonly namespace: string;
	readonly onEvent?: (event: UpstreamToolEvent) => Promise<void> | void;
	readonly requestId?: string;
	readonly signal?: AbortSignal;
	readonly toolName: string;
}

export type UpstreamToolEvent =
	| {
			readonly kind: 'progress';
			readonly message?: string;
			readonly progress: number;
			readonly total?: number;
	  }
	// Extension event for runtimes that can source request-correlated MCP notifications.
	// The stock SDK callTool bridge currently emits real progress via RequestOptions.onprogress.
	| {
			readonly kind: 'upstream_notification';
			readonly method: string;
			readonly params: unknown;
	  }
	// Extension event for runtimes that can source incremental content before the final result.
	| {
			readonly content:
				| { readonly text: string; readonly type: 'text' }
				| { readonly type: 'json'; readonly value: unknown };
			readonly kind: 'partial_content';
	  };

export type UpstreamMcpProgress = Progress;

export interface UpstreamListToolsResult {
	readonly nextCursor?: string | undefined;
	readonly tools: readonly Tool[];
}

export interface UpstreamMcpClientLike {
	readonly callTool: (
		params: {
			readonly arguments: JsonObject;
			readonly name: string;
		},
		resultSchema?: unknown,
		options?: {
			readonly onprogress?: (progress: UpstreamMcpProgress) => void;
			readonly signal?: AbortSignal;
		},
	) => Promise<unknown>;
	readonly close: () => Promise<void> | void;
	readonly connect: (
		transport: unknown,
		options?: { readonly signal?: AbortSignal },
	) => Promise<void>;
	readonly listTools: (
		params?: { readonly cursor?: string },
		options?: { readonly signal?: AbortSignal },
	) => Promise<UpstreamListToolsResult>;
}

export type UpstreamMcpTransport = Pick<
	Transport,
	'start' | 'send' | 'close' | 'onclose' | 'onerror' | 'onmessage'
>;

export interface UpstreamMcpRuntimeOptions {
	readonly additionalRedactionValues?: readonly string[];
	readonly createClient?: () => UpstreamMcpClientLike;
	readonly createUpstreamMcpTransport: (
		server: NormalizedUpstreamMcpServer,
		transport: Exclude<UpstreamMcpTransportKind, 'auto-http'>,
	) => UpstreamMcpTransport;
	readonly maxResponseBytes?: number;
	readonly onCloseError?: (error: Error, context: UpstreamMcpCloseErrorContext) => void;
	readonly servers: readonly NormalizedUpstreamMcpServer[];
}

export interface UpstreamMcpCloseErrorContext {
	readonly agentScopeId: string;
	readonly namespace?: string;
}

export interface UpstreamMcpClientRuntime {
	readonly callTool: (call: UpstreamToolCall) => Promise<unknown>;
	readonly closeAgentScope: (agentScopeId: string) => Promise<void>;
	readonly closeSession: (scopeKey: string) => Promise<void>;
	readonly listTools: (call: ListToolsCall) => Promise<readonly Tool[]>;
}
