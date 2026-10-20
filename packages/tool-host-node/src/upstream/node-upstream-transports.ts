import {
	redactCredentialText,
	type UpstreamMcpRuntimeOptions,
} from '@agent-collaboration/tool-engine/connectors';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type {
	NormalizedUpstreamMcpServer,
	UpstreamMcpRuntimeOptions as StdioRuntimeOptions,
} from '#node-host/upstream/stdio-upstream-protocol';

const inheritedStdioRuntimeEnvNames = [
	'NODE_EXTRA_CA_CERTS',
	'NODE_OPTIONS',
	'REQUESTS_CA_BUNDLE',
	'SSL_CERT_FILE',
	'UV_CACHE_DIR',
] as const;

export function withNodeStdioEnvironment(
	server: NormalizedUpstreamMcpServer,
): NormalizedUpstreamMcpServer {
	const inheritedEnv: Record<string, string> = {};
	for (const name of inheritedStdioRuntimeEnvNames) {
		const value = process.env[name];
		if (value !== undefined && value.length > 0) inheritedEnv[name] = value;
	}
	return { ...server, env: { ...inheritedEnv, ...server.env } };
}

export const createNodeHttpUpstreamTransport: UpstreamMcpRuntimeOptions['createUpstreamMcpTransport'] =
	(server, transport) => {
		const url = new URL(server.url);
		if (transport === 'sse')
			return withOrderedUpstreamMessages(
				new SSEClientTransport(url, {
					...(server.eventSourceInit === undefined
						? {}
						: { eventSourceInit: server.eventSourceInit }),
					...(server.requestInit === undefined ? {} : { requestInit: server.requestInit }),
				}),
			);
		return new StreamableHTTPClientTransport(
			url,
			server.requestInit === undefined ? {} : { requestInit: server.requestInit },
		);
	};

export function createNodeStdioUpstreamTransport(
	props: {
		readonly stderr?: (text: string) => void;
	} = {},
): StdioRuntimeOptions['createUpstreamMcpTransport'] {
	return (server) => {
		const env = server.env ?? {};
		const transport = new StdioClientTransport({
			command: server.command,
			...(server.args === undefined ? {} : { args: [...server.args] }),
			...(server.cwd === undefined ? {} : { cwd: server.cwd }),
			env,
			stderr: 'pipe',
		});
		transport.stderr?.on('data', (chunk: Buffer | string): void => {
			props.stderr?.(redactCredentialText(String(chunk), { exactValues: Object.values(env) }));
		});
		return withOrderedUpstreamMessages(transport);
	};
}

function withOrderedUpstreamMessages(transport: Transport): Transport {
	let deliveries = Promise.resolve();
	const orderedTransport: Transport = {
		start: async () => {
			Object.assign(transport, {
				onmessage: (message: JSONRPCMessage): void => {
					// SDK 1.29 defers notification handlers. Preserve wire order across
					// their microtasks before a coalesced result removes the progress token.
					deliveries = deliveries
						.then(() => {
							orderedTransport.onmessage?.(message);
						})
						.catch((error: unknown) => {
							orderedTransport.onerror?.(
								error instanceof Error ? error : new Error('Upstream message delivery failed.'),
							);
						});
				},
				onerror: (error: Error): void => orderedTransport.onerror?.(error),
				onclose: (): void => {
					void deliveries.then(() => orderedTransport.onclose?.());
				},
			});
			await transport.start();
		},
		send: async (message, options) => transport.send(message, options),
		...(transport.setProtocolVersion === undefined
			? {}
			: { setProtocolVersion: (version: string): void => transport.setProtocolVersion?.(version) }),
		close: async () => {
			await transport.close();
			await deliveries;
		},
	};
	return orderedTransport;
}
