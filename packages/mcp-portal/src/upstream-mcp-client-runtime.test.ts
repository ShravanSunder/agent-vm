import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { JSONRPCMessage, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
} from './testing/fake-upstream-mcp-server.js';
import {
	createUpstreamMcpClientRuntime,
	type NormalizedUpstreamMcpServer,
	type RemoteUpstreamMcpServer,
	type UpstreamMcpClientLike,
	type UpstreamListToolsResult,
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
	afterEach(() => {
		vi.unstubAllEnvs();
	});

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
		expect(client.listTools).toHaveBeenNthCalledWith(2, { cursor: 'next' }, expect.any(Object));
	});

	it('preserves gateway Node runtime env for stdio MCP servers', async () => {
		vi.stubEnv('NODE_EXTRA_CA_CERTS', '/run/gondolin/ca-certificates.crt');
		vi.stubEnv('NODE_OPTIONS', '--dns-result-order=ipv4first');
		const createTransport = vi.fn(() => ({}));
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport,
			servers: [
				{
					args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
					command: 'npx',
					env: { PERPLEXITY_API_KEY: 'secret-token-value' },
					namespace: 'perplexity',
					transport: 'stdio',
				},
			],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'perplexity' }),
		).resolves.toEqual([]);

		expect(createTransport).toHaveBeenCalledWith(
			{
				args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
				command: 'npx',
				env: {
					NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
					NODE_OPTIONS: '--dns-result-order=ipv4first',
					PERPLEXITY_API_KEY: 'secret-token-value',
				},
				namespace: 'perplexity',
				transport: 'stdio',
			},
			'stdio',
		);
	});

	it('preserves gateway Python and uv runtime env for stdio MCP servers', async () => {
		vi.stubEnv('REQUESTS_CA_BUNDLE', '/run/gondolin/ca-certificates.crt');
		vi.stubEnv('SSL_CERT_FILE', '/run/gondolin/ca-certificates.crt');
		vi.stubEnv('UV_CACHE_DIR', '/work/cache/uv');
		const createTransport = vi.fn(() => ({}));
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport,
			servers: [
				{
					args: ['run', 'mcp-server-example'],
					command: 'uv',
					env: { EXAMPLE_API_KEY: 'secret-token-value' },
					namespace: 'python_docs',
					transport: 'stdio',
				},
			],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'python_docs' }),
		).resolves.toEqual([]);

		expect(createTransport).toHaveBeenCalledWith(
			{
				args: ['run', 'mcp-server-example'],
				command: 'uv',
				env: {
					EXAMPLE_API_KEY: 'secret-token-value',
					REQUESTS_CA_BUNDLE: '/run/gondolin/ca-certificates.crt',
					SSL_CERT_FILE: '/run/gondolin/ca-certificates.crt',
					UV_CACHE_DIR: '/work/cache/uv',
				},
				namespace: 'python_docs',
				transport: 'stdio',
			},
			'stdio',
		);
	});

	it('wraps listTools timeout with structured upstream diagnostics', async () => {
		const neverListingClient: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => await new Promise<UpstreamListToolsResult>(() => undefined)),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => neverListingClient,
			createTransport: vi.fn(() => ({})),
			servers: [
				createServer({
					connectionTimeoutMs: 5,
					headers: { Authorization: 'secret-token-value' },
				}),
			],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).rejects.toMatchObject({
			details: {
				causeMessage: expect.stringContaining('MCP listTools timed out after 5ms'),
				kind: 'upstream_mcp_failed',
				namespace: 'linear',
				phase: 'list_tools',
				timeoutMs: 5,
				transport: { kind: 'streamable-http', url: 'https://mcp.example.test' },
			},
		});
		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).rejects.not.toThrow(/secret-token-value/u);
	});

	it('wraps stdio connect failures with command and arg count diagnostics', async () => {
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => ({
				callTool: vi.fn(),
				close: vi.fn(),
				connect: vi.fn(async () => {
					throw new Error('spawn ENOENT');
				}),
				listTools: vi.fn(),
			}),
			createTransport: vi.fn(() => ({})),
			servers: [
				{
					args: ['-y', '-p', '@perplexity-ai/mcp-server', 'wrong-bin'],
					command: 'npx',
					env: { PERPLEXITY_API_KEY: 'secret-token-value' },
					namespace: 'perplexity',
					transport: 'stdio',
				},
			],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'perplexity' }),
		).rejects.toMatchObject({
			details: {
				causeMessage: 'spawn ENOENT',
				hint: expect.stringContaining('stdio MCP command failed before tool discovery'),
				kind: 'upstream_mcp_failed',
				namespace: 'perplexity',
				phase: 'connect',
				transport: {
					argCount: 4,
					command: 'npx',
					kind: 'stdio',
				},
			},
		});
	});

	it('threads timeout abort signals into listTools requests', async () => {
		const listToolSignals: (AbortSignal | undefined)[] = [];
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async (_params, options) => {
				listToolSignals.push(options?.signal);
				return { tools: [] };
			}),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: vi.fn(() => ({})),
			servers: [createServer()],
		});

		await runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' });

		expect(listToolSignals).toEqual([expect.any(AbortSignal)]);
	});

	it('threads timeout abort signals into connect requests', async () => {
		const connectSignals: (AbortSignal | undefined)[] = [];
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(async (_transport, options) => {
				connectSignals.push(options?.signal);
			}),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: vi.fn(() => ({})),
			servers: [createServer()],
		});

		await runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' });

		expect(connectSignals).toEqual([expect.any(AbortSignal)]);
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

	it('passes progress and abort options through upstream tool calls', async () => {
		const controller = new AbortController();
		const progressEvents: unknown[] = [];
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(async (_params, _resultSchema, options) => {
				expect(options?.signal).toBeDefined();
				expect(options?.signal?.aborted).toBe(false);
				options?.onprogress?.({
					message: 'upstream half done',
					progress: 5,
					total: 10,
				});
				controller.abort(new Error('caller cancelled'));
				expect(options?.signal?.aborted).toBe(true);
				return { content: [] };
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

		await runtime.callTool({
			arguments: {},
			agentScopeId: 'agent-scope-a',
			namespace: 'linear',
			onEvent: (progress) => {
				progressEvents.push(progress);
			},
			signal: controller.signal,
			toolName: 'create_issue',
		});

		expect(progressEvents).toEqual([
			{
				kind: 'progress',
				message: 'upstream half done',
				progress: 5,
				total: 10,
			},
		]);
		expect(client.callTool).toHaveBeenCalledWith(
			{ arguments: {}, name: 'create_issue' },
			undefined,
			expect.objectContaining({
				onprogress: expect.any(Function),
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it('aborts the upstream callTool request when the configured timeout expires', async () => {
		let observedSignal: AbortSignal | undefined;
		const abortObserved = createDeferred<void>();
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn((_params, _resultSchema, options) => {
				observedSignal = options?.signal;
				observedSignal?.addEventListener('abort', () => abortObserved.resolve(undefined), {
					once: true,
				});
				return new Promise<never>(() => undefined);
			}),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer({ connectionTimeoutMs: 1 })],
		});

		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'agent-scope-a',
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).rejects.toThrow(/timed out after 1ms/u);

		expect(observedSignal).toBeDefined();
		await abortObserved.promise;
		expect(observedSignal?.aborted).toBe(true);
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

	it('exact-redacts all resolved stdio env values from tool catalogs', async () => {
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
				description: 'run [REDACTED]/tool',
				inputSchema: { type: 'object' },
				name: 'inspect_path',
			},
		]);
	});

	it('rejects upstream call results that exceed the configured response byte cap', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(async () => ({
				content: [{ text: 'x'.repeat(256), type: 'text' }],
			})),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			maxResponseBytes: 100,
			servers: [createServer()],
		});

		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'agent-scope-a',
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).rejects.toThrow(/exceeded 100 bytes/u);
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

	it('keeps cached clients after caller cancellation aborts callTool', async () => {
		const abortError = new DOMException('caller cancelled', 'AbortError');
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn().mockRejectedValueOnce(abortError).mockResolvedValueOnce({ ok: true }),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer()],
		});
		const controller = new AbortController();
		controller.abort(abortError);

		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'agent-scope-a',
				namespace: 'linear',
				signal: controller.signal,
				toolName: 'create_issue',
			}),
		).rejects.toThrow('caller cancelled');
		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'agent-scope-a',
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).resolves.toEqual({ ok: true });

		expect(client.connect).toHaveBeenCalledTimes(1);
		expect(client.close).not.toHaveBeenCalled();
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

	it('closes a client when connect times out before the SDK promise resolves', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(() => new Promise<never>(() => undefined)),
			listTools: vi.fn(),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer({ connectionTimeoutMs: 1 })],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).rejects.toThrow(/connect.*timed out/u);
		expect(client.close).toHaveBeenCalledTimes(1);
	});

	it('closes a client when listTools times out before the SDK promise resolves', async () => {
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(() => new Promise<never>(() => undefined)),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: () => ({}),
			servers: [createServer({ connectionTimeoutMs: 1 })],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).rejects.toThrow(/listTools.*timed out/u);
		expect(client.close).toHaveBeenCalledTimes(1);
	});

	it('does not cache or double-close a pending client that resolves after agent scope close', async () => {
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
		expect(clients[0]?.close).toHaveBeenCalledTimes(1);
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
