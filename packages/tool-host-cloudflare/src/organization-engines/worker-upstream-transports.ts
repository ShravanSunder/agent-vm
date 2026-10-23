import type { UpstreamMcpRuntimeOptions } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import { SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Return SDK v2 transports; Engine owns automatic protocol negotiation. */
export const createWorkerUpstreamTransport: UpstreamMcpRuntimeOptions['createUpstreamMcpTransport'] =
	(server, kind) => {
		const url = new URL(server.url);
		return kind === 'sse'
			? new SSEClientTransport(
					url,
					server.requestInit === undefined ? {} : { requestInit: server.requestInit },
				)
			: new StreamableHTTPClientTransport(
					url,
					server.requestInit === undefined ? {} : { requestInit: server.requestInit },
				);
	};
