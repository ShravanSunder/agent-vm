import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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
			runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' }),
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

		await runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' });

		expect(attempts).toEqual(['streamable-http', 'sse']);
	});

	it('passes SSE headers through requestInit so the SDK applies them to GET and POST', async () => {
		const transports: unknown[] = [];
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: vi.fn((server, transport) => {
				const built = { server, transport };
				transports.push(built);
				return built;
			}),
			servers: [createServer({ transport: 'sse' })],
		});

		await runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' });

		expect(transports).toEqual([
			{
				server: expect.objectContaining({
					requestInit: expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }),
				}),
				transport: 'sse',
			},
		]);
	});

	it('does not share cached clients across portal bindings and evicts failures', async () => {
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

		await runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' });
		await runtime.listTools({ bindingId: 'binding-b', namespace: 'linear' });

		expect(clients).toHaveLength(2);
	});

	it('deduplicates concurrent first-use connections for the same binding namespace', async () => {
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
			runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' }),
			runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' }),
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
				bindingId: 'binding-a',
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
				bindingId: 'binding-a',
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

		const tools = await runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' });

		expect(JSON.stringify(tools)).not.toContain('opaque-header-value-12345');
		expect(JSON.stringify(tools)).toContain('[REDACTED]');
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
			runtime.listTools({ bindingId: 'binding-a', namespace: 'local' }),
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
				bindingId: 'binding-a',
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
			runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' }),
		).rejects.toThrow('list failed');

		expect(client.close).toHaveBeenCalledTimes(1);
	});

	it('does not cache a pending client that resolves after binding close', async () => {
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
			bindingId: 'binding-a',
			namespace: 'linear',
		});
		await connectStarted.promise;
		const closePromise = runtime.closeBinding('binding-a');
		allowConnect.resolve(undefined);

		await expect(firstListPromise).rejects.toThrow(/invalidated/);
		await closePromise;
		expect(clients[0]?.close).toHaveBeenCalledTimes(2);
		await expect(
			runtime.listTools({ bindingId: 'binding-a', namespace: 'linear' }),
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
			runtime.listTools({ bindingId: 'binding-a\nsession-a', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_1' }]);
		await expect(
			runtime.listTools({ bindingId: 'binding-a\nsession-b', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_2' }]);
		await runtime.closeSession('binding-a\nsession-a');
		await expect(
			runtime.listTools({ bindingId: 'binding-a\nsession-a', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_3' }]);
		await expect(
			runtime.listTools({ bindingId: 'binding-a\nsession-b', namespace: 'linear' }),
		).resolves.toEqual([{ inputSchema: { type: 'object' }, name: 'tool_2' }]);

		expect(clients[0]?.close).toHaveBeenCalledTimes(1);
		expect(clients[1]?.close).not.toHaveBeenCalled();
		expect(clients).toHaveLength(3);
	});
});
