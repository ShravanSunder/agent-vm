import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
	RemoteUpstreamMcpServer,
	NormalizedUpstreamMcpServer,
} from '#connectors/models/upstream-mcp-server';
import { createUpstreamMcpClientRuntime as createRuntime } from '#connectors/upstream-mcp-client-runtime';
import type { UpstreamMcpRuntimeOptions } from '#connectors/upstream-mcp-protocol';

export function createServer(
	overrides: Partial<RemoteUpstreamMcpServer> = {},
): NormalizedUpstreamMcpServer {
	return {
		headers: { Authorization: 'Bearer secret' },
		namespace: 'linear',
		transport: 'streamable-http',
		url: 'https://mcp.example.test',
		...overrides,
	};
}

export function createDeferred<TValue>(): {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
} {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) {
		throw new Error('deferred resolver was not initialized');
	}
	return { promise, resolve: resolvePromise };
}

export function fakeTransport(): Transport {
	return { start: async () => {}, send: async () => {}, close: async () => {} };
}

export function createUpstreamMcpClientRuntime(
	options: Omit<UpstreamMcpRuntimeOptions, 'createUpstreamMcpTransport'> & {
		readonly createTransport?: UpstreamMcpRuntimeOptions['createUpstreamMcpTransport'];
	},
): ReturnType<typeof createRuntime> {
	return createRuntime({
		...options,
		createUpstreamMcpTransport:
			options.createTransport ??
			((server, transport) =>
				transport === 'sse'
					? new SSEClientTransport(new URL(server.url), {
							...(server.requestInit === undefined
								? {}
								: server.requestInit === undefined
									? {}
									: { requestInit: server.requestInit }),
							...(server.eventSourceInit === undefined
								? {}
								: { eventSourceInit: server.eventSourceInit }),
						})
					: new StreamableHTTPClientTransport(
							new URL(server.url),
							server.requestInit === undefined ? {} : { requestInit: server.requestInit },
						)),
	});
}
