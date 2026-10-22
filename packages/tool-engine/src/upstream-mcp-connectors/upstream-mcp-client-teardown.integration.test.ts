import type { Tool } from '@modelcontextprotocol/client';
import { describe, afterEach, vi, it, expect } from 'vitest';

import {
	createServer,
	createDeferred,
	fakeTransport,
	createUpstreamMcpClientRuntime,
} from '#upstream-mcp-connectors/test-fixtures/upstream-mcp-client-fixture';
import type { UpstreamMcpClientLike } from '#upstream-mcp-connectors/upstream-mcp-protocol';

describe('upstream MCP session lifecycle', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
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
