import type { Tool } from '@modelcontextprotocol/client';
import { describe, afterEach, vi, it, expect } from 'vitest';

import {
	createServer,
	createDeferred,
	fakeTransport,
	createUpstreamMcpClientRuntime,
} from '#upstream-mcp-connectors/test-fixtures/upstream-mcp-client-fixture';
import type {
	UpstreamMcpClientLike,
	UpstreamListToolsResult,
} from '#upstream-mcp-connectors/upstream-mcp-protocol';

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
			callTool: vi.fn(async (_params, options) => {
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
			callTool: vi.fn((_params, options) => {
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
});
