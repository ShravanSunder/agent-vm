import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createUpstreamMcpClientRuntime as createRuntime } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import type { UpstreamMcpRuntimeOptions } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import {
	startFakeUpstreamMcpServer,
	fakeUpstreamNamespace,
} from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, afterEach, vi, it, expect } from 'vitest';

function portFromServerAddress(address: AddressInfo | string | null): number {
	if (typeof address === 'object' && address !== null) {
		return address.port;
	}
	throw new Error('test HTTP server did not expose a TCP port');
}

describe('upstream MCP HTTP transport', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('passes SSE headers through requestInit so the SDK applies them to GET and POST', async () => {
		const recordedRequests: {
			readonly authorization: string | undefined;
			readonly method: string | undefined;
			readonly url: string | undefined;
		}[] = [];
		const server = createHttpServer((request, response) => {
			recordedRequests.push({
				authorization: request.headers.authorization,
				method: request.method,
				url: request.url,
			});
			if (request.method === 'GET' && request.url === '/sse') {
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.write('event: endpoint\ndata: /messages\n\n');
				return;
			}
			if (request.method === 'POST' && request.url === '/messages') {
				response.writeHead(202);
				response.end();
				return;
			}
			response.writeHead(404);
			response.end();
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const port = portFromServerAddress(server.address());
		const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
			requestInit: { headers: { Authorization: 'Bearer secret' } },
		});

		try {
			await transport.start();
			await transport.send({
				id: 1,
				jsonrpc: '2.0',
				method: 'ping',
			} satisfies JSONRPCMessage);
			expect(recordedRequests).toEqual([
				{ authorization: 'Bearer secret', method: 'GET', url: '/sse' },
				{ authorization: 'Bearer secret', method: 'POST', url: '/messages' },
			]);
		} finally {
			await transport.close();
			server.close();
			await once(server, 'close');
		}
	});

	it('forwards real SDK progress notifications from the default MCP client', async () => {
		const upstream = await startFakeUpstreamMcpServer({ emitProgress: true });
		const progressEvents: unknown[] = [];
		const runtime = createUpstreamMcpClientRuntime({
			servers: [
				{
					namespace: fakeUpstreamNamespace,
					transport: 'streamable-http',
					url: upstream.url,
				},
			],
		});
		try {
			await runtime.callTool({
				arguments: { title: 'hello' },
				agentScopeId: 'agent-scope-a',
				namespace: fakeUpstreamNamespace,
				onEvent: (event) => {
					progressEvents.push(event);
				},
				toolName: 'read_thing',
			});

			expect(progressEvents).toEqual([
				{
					kind: 'progress',
					message: 'fake upstream half done',
					progress: 1,
					total: 2,
				},
			]);
		} finally {
			await runtime.closeAgentScope('agent-scope-a');
			await upstream.close();
		}
	});

	it('rejects a real streamable HTTP MCP tool error result', async () => {
		// Arrange
		const upstream = await startFakeUpstreamMcpServer({
			toolErrorMessageByToolName: {
				read_thing:
					'Input validation failed at $.search_recency: expected day, week, or month. Authorization: Bearer schema-secret',
			},
		});
		const runtime = createUpstreamMcpClientRuntime({
			servers: [
				{
					namespace: fakeUpstreamNamespace,
					transport: 'streamable-http',
					url: upstream.url,
				},
			],
		});

		try {
			// Act / Assert
			await expect(
				runtime.callTool({
					arguments: { title: 'schema probe' },
					agentScopeId: 'agent-scope-a',
					namespace: fakeUpstreamNamespace,
					toolName: 'read_thing',
				}),
			).rejects.toMatchObject({
				details: {
					failureClass: 'tool_error',
					kind: 'upstream_mcp_failed',
					namespace: fakeUpstreamNamespace,
					phase: 'call_tool',
					providerErrorMessage:
						'Input validation failed at $.search_recency: expected day, week, or month. Authorization: [REDACTED]',
					transport: { kind: 'streamable-http' },
				},
			});
		} finally {
			await runtime.closeAgentScope('agent-scope-a');
			await upstream.close();
		}
	});

	it.each([
		{ expectedFailureClass: 'invalid_request', httpStatusCode: 400 },
		{ expectedFailureClass: 'authentication', httpStatusCode: 401 },
		{ expectedFailureClass: 'authorization', httpStatusCode: 403 },
		{ expectedFailureClass: 'rate_limit', httpStatusCode: 429 },
		{ expectedFailureClass: 'provider_error', httpStatusCode: 500 },
	] as const)(
		'classifies remote streamable HTTP $httpStatusCode failures as $expectedFailureClass without preserving response text',
		async ({ expectedFailureClass, httpStatusCode }) => {
			// Arrange
			const upstream = await startFakeUpstreamMcpServer({ callHttpStatusCode: httpStatusCode });
			const runtime = createUpstreamMcpClientRuntime({
				servers: [
					{
						namespace: fakeUpstreamNamespace,
						transport: 'streamable-http',
						url: upstream.url,
					},
				],
			});

			try {
				// Act
				const call = runtime.callTool({
					arguments: { title: 'hello' },
					agentScopeId: 'agent-scope-a',
					namespace: fakeUpstreamNamespace,
					toolName: 'read_thing',
				});

				// Assert
				await expect(call).rejects.toMatchObject({
					details: {
						causeMessage: 'Remote MCP request failed.',
						failureClass: expectedFailureClass,
						httpStatusCode,
						kind: 'upstream_mcp_failed',
						namespace: fakeUpstreamNamespace,
						phase: 'call_tool',
					},
				});
				await expect(call).rejects.not.toThrow(/provider response detail/u);
			} finally {
				await runtime.closeAgentScope('agent-scope-a');
				await upstream.close();
			}
		},
	);
});

function createUpstreamMcpClientRuntime(
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
