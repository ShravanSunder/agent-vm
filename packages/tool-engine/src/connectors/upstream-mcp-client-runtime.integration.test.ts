import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UpstreamMcpRuntimeOptions } from '#connectors/upstream-mcp-client-runtime';
import {
	createUpstreamMcpClientRuntime as createRuntime,
	type NormalizedUpstreamMcpServer,
	type RemoteUpstreamMcpServer,
	type UpstreamMcpClientLike,
	type UpstreamListToolsResult,
} from '#connectors/upstream-mcp-client-runtime';

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
describe('upstream MCP session lifecycle', () => {
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
			createTransport: vi.fn(fakeTransport),
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

	it('wraps listTools timeout with structured upstream diagnostics', async () => {
		const neverListingClient: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => await new Promise<UpstreamListToolsResult>(() => undefined)),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => neverListingClient,
			createTransport: vi.fn(fakeTransport),
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
				transport: { kind: 'streamable-http', url: 'https://mcp.example.test/' },
			},
		});
		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).rejects.not.toThrow(/secret-token-value/u);
	});

	it('uses 12 seconds as the default namespace discovery timeout', async () => {
		const failingClient: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => {
				throw new Error('list failed');
			}),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => failingClient,
			createTransport: vi.fn(fakeTransport),
			servers: [createServer()],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' }),
		).rejects.toMatchObject({
			details: {
				namespace: 'linear',
				phase: 'list_tools',
				timeoutMs: 12_000,
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
			createTransport: vi.fn(fakeTransport),
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
			createTransport: vi.fn(fakeTransport),
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
				return fakeTransport();
			}),
			servers: [createServer({ transport: 'auto-http' })],
		});

		await runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'linear' });

		expect(attempts).toEqual(['streamable-http', 'sse']);
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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
			createTransport: fakeTransport,
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

function fakeTransport(): Transport {
	return { start: async () => {}, send: async () => {}, close: async () => {} };
}
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
