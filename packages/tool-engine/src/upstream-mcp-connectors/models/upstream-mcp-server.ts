import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';

export type UpstreamMcpTransportKind = 'auto-http' | 'sse' | 'streamable-http';

interface BaseUpstreamMcpServer {
	readonly connectionTimeoutMs?: number;
	readonly namespace: string;
	readonly transport: UpstreamMcpTransportKind;
}

export interface RemoteUpstreamMcpServer extends BaseUpstreamMcpServer {
	readonly eventSourceInit?: SSEClientTransportOptions['eventSourceInit'];
	readonly headers?: Readonly<Record<string, string>>;
	readonly requestInit?: RequestInit;
	readonly transport: 'auto-http' | 'sse' | 'streamable-http';
	readonly url: string;
}

export type NormalizedUpstreamMcpServer = RemoteUpstreamMcpServer;
