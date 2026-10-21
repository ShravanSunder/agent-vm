import type { UpstreamMcpRuntimeOptions } from '@agent-collaboration/tool-engine/connectors';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Outbound SDK v1 client/transport behavior is unchanged while owner question 8 remains open. */
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
