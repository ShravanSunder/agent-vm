import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { JSONRPCMessage, Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import {
	createUpstreamMcpClientRuntime,
	type NormalizedUpstreamMcpServer,
	type RemoteUpstreamMcpServer,
	type UpstreamMcpClientLike,
} from './upstream-mcp-client-runtime.js';

function createServer(
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

function createDeferred<TValue>(): {
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

function portFromServerAddress(address: AddressInfo | string | null): number {
	if (typeof address === 'object' && address !== null) {
		return address.port;
	}
	throw new Error('test HTTP server did not expose a TCP port');
}

describe('upstream MCP client runtime', () => {
	it('pages listTools until nextCursor is absent', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi
				.fn()
				.mockResolvedValueOnce({
					nextCursor: 'next',
					tools: [{ inputSchema: { type: 'object' }, name: 'a' }],
				})
				.mockResolvedValueOnce({ tools: [{ inputSchema: { type: 'object' }, name: 'b' }] }),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: vi.fn(() => ({})),
			servers: [createServer()],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).resolves.toEqual([
			{ inputSchema: { type: 'object' }, name: 'a' },
			{ inputSchema: { type: 'object' }, name: 'b' },
		]);
		expect(client.listTools).toHaveBeenNthCalledWith(2, { cursor: 'next' });
	});

	it('tries Streamable HTTP before SSE for unspecified remote transport', async () => {
		const attempts: string[] = [];
		const streamableClient: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(async () => {
				throw new Error('streamable failed');
			}),
			listTools: vi.fn(),
		};
		const sseClient: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: vi.fn(() => (attempts.length === 1 ? sseClient : streamableClient)),
			createTransport: vi.fn((_server, transport) => {
				attempts.push(transport);
				return {};
			}),
			servers: [createServer({ transport: 'auto-http' })],
		});

		await runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' });

		expect(attempts).toEqual(['streamable-http', 'sse']);
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

	it('does not share cached clients across portal agent scopes and evicts failures', async () => {
		const clients: UpstreamMcpClientLike[] = [];
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => {
				const client: UpstreamMcpClientLike = {
					callTool: vi.fn(),
					close: vi.fn(),
					connect: vi.fn(),
					listTools: vi.fn(async () => ({ tools: [] })),
				};
				clients.push(client);
				return client;
			},
			createTransport: () => ({}),
			servers: [createServer()],
		});

		await runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' });
		await runtime.listTools({ agentScopeId: 'agent-scope-b', namespace: 'linear' });

		expect(clients).toHaveLength(2);
	});

	it('deduplicates concurrent first-use connections for the same agent scope namespace', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(async () => undefined),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const createClient = vi.fn(() => client);
		const runtime = createUpstreamMcpClientRuntime({
			createClient,
			createTransport: () => ({}),
			servers: [createServer()],
		});

		await Promise.all([
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		]);

		expect(createClient).toHaveBeenCalledTimes(1);
		expect(client.connect).toHaveBeenCalledTimes(1);
	});

	it('redacts call results and thrown errors through middleware', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(async () => ({ content: [{ text: 'Bearer secret-token', type: 'text' }] })),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer()],
		});

		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'agent-scope-a',
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).resolves.toEqual({ content: [{ text: '[REDACTED]', type: 'text' }] });
	});

	it('redacts exact upstream header values from call results', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(async () => ({
				content: [{ text: 'opaque-header-value-12345', type: 'text' }],
			})),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer({ headers: { 'x-api-key': 'opaque-header-value-12345' } })],
		});

		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'agent-scope-a',
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).resolves.toEqual({ content: [{ text: '[REDACTED]', type: 'text' }] });
	});

	it('redacts configured secret values from tool catalogs before indexing', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({
				tools: [
					{
						description: 'uses opaque-header-value-12345',
						inputSchema: {
							properties: {
								token: { default: 'opaque-header-value-12345', type: 'string' },
							},
							type: 'object',
						},
						name: 'create_issue',
					} satisfies Tool,
				],
			})),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer({ headers: { 'x-api-key': 'opaque-header-value-12345' } })],
		});

		const tools = await runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' });

		expect(JSON.stringify(tools)).not.toContain('opaque-header-value-12345');
		expect(JSON.stringify(tools)).toContain('[REDACTED]');
	});

	it('keeps credential-shaped catalog examples unless they match exact secrets', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({
				tools: [
					{
						description: 'Pass Authorization: Bearer EXAMPLE in the request.',
						inputSchema: {
							properties: {
								example: { default: 'api_key=example-value', type: 'string' },
							},
							type: 'object',
						},
						name: 'document_auth',
					} satisfies Tool,
				],
			})),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer({ headers: { Authorization: 'Bearer real-secret' } })],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).resolves.toEqual([
			{
				description: 'Pass Authorization: Bearer EXAMPLE in the request.',
				inputSchema: {
					properties: {
						example: { default: 'api_key=example-value', type: 'string' },
					},
					type: 'object',
				},
				name: 'document_auth',
			},
		]);
	});

	it('does not exact-redact non-credential stdio env values from tool catalogs', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({
				tools: [
					{
						description: 'run /usr/local/bin/tool',
						inputSchema: { type: 'object' },
						name: 'inspect_path',
					} satisfies Tool,
				],
			})),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [
				{
					command: 'tool',
					env: { PATH: '/usr/local/bin', TOKEN: 'secret-token-value' },
					namespace: 'local',
					transport: 'stdio',
				},
			],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'local' }),
		).resolves.toEqual([
			{
				description: 'run /usr/local/bin/tool',
				inputSchema: { type: 'object' },
				name: 'inspect_path',
			},
		]);
	});

	it('closes cached clients after callTool failures', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(async () => {
				throw new Error('upstream failed');
			}),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer()],
		});

		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'agent-scope-a',
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).rejects.toThrow('upstream failed');

		expect(client.close).toHaveBeenCalledTimes(1);
	});

	it('closes cached clients after listTools failures', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => {
				throw new Error('list failed');
			}),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer()],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).rejects.toThrow('list failed');

		expect(client.close).toHaveBeenCalledTimes(1);
	});

	it('does not cache a pending client that resolves after agent scope close', async () => {
		const connectStarted = createDeferred<void>();
		const allowConnect = createDeferred<void>();
		const clients: UpstreamMcpClientLike[] = [];
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => {
				const client: UpstreamMcpClientLike = {
					callTool: vi.fn(),
					close: vi.fn(),
					connect: vi.fn(async () => {
						connectStarted.resolve(undefined);
						await allowConnect.promise;
					}),
					listTools: vi.fn(async () => ({
						tools: [
							{ inputSchema: { type: 'object' }, name: `tool_${clients.length}` } satisfies Tool,
						],
					})),
				};
				clients.push(client);
				return client;
			},
			createTransport: () => ({}),
			servers: [createServer()],
		});

		const firstListPromise = runtime.listTools({
			agentScopeId: 'agent-scope-a',
			namespace: 'linear',
		});
		await connectStarted.promise;
		const closePromise = runtime.closeAgentScope('agent-scope-a');
		allowConnect.resolve(undefined);

		await expect(firstListPromise).rejects.toThrow(/invalidated/);
		await closePromise;
		expect(clients[0]?.close).toHaveBeenCalledTimes(2);
		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_2' }]);
		expect(clients).toHaveLength(2);
	});

	it('closes only the requested transport-session scoped clients', async () => {
		const clients: UpstreamMcpClientLike[] = [];
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => {
				const clientIndex = clients.length + 1;
				const client: UpstreamMcpClientLike = {
					callTool: vi.fn(),
					close: vi.fn(),
					connect: vi.fn(),
					listTools: vi.fn(async () => ({
						tools: [
							{ inputSchema: { type: 'object' }, name: `tool_${clientIndex}` } satisfies Tool,
						],
					})),
				};
				clients.push(client);
				return client;
			},
			createTransport: () => ({}),
			servers: [createServer()],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a\nsession-a', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_1' }]);
		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a\nsession-b', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_2' }]);
		await runtime.closeSession('agent-scope-a\nsession-a');
		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a\nsession-a', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_3' }]);
		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a\nsession-b', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_2' }]);

		expect(clients[0]?.close).toHaveBeenCalledTimes(1);
		expect(clients[1]?.close).not.toHaveBeenCalled();
		expect(clients).toHaveLength(3);
	});

	it('reports close failures during normal agent scope teardown', async () => {
		const closeErrors: Error[] = [];
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(async () => {
				throw new Error('close failed');
			}),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			onCloseError: (error) => {
				closeErrors.push(error);
			},
			servers: [createServer()],
		});

		await runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' });
		await runtime.closeAgentScope('agent-scope-a');

		expect(closeErrors.map((error) => error.message)).toEqual(['close failed']);
	});
});
