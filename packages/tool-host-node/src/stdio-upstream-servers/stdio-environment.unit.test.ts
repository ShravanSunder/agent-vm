import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UpstreamMcpClientLike } from '#node-host/stdio-upstream-servers/models/stdio-upstream-protocol';
import { createNodeStdioUpstreamRuntime as createUpstreamMcpClientRuntime } from '#node-host/stdio-upstream-servers/stdio-upstream-runtime';
const dummyTransport = {
	start: async (): Promise<void> => {},
	send: async (): Promise<void> => {},
	close: async (): Promise<void> => {},
};
afterEach(() => vi.unstubAllEnvs());
describe('copied stdio environment and diagnostics contracts', () => {
	it('preserves gateway Node runtime env for stdio MCP servers', async () => {
		vi.stubEnv('NODE_EXTRA_CA_CERTS', '/run/gondolin/ca-certificates.crt');
		vi.stubEnv('NODE_OPTIONS', '--dns-result-order=ipv4first');
		const createTransport = vi.fn(() => dummyTransport);
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createUpstreamMcpTransport: createTransport,
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
			expect.objectContaining({
				args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
				command: 'npx',
				env: expect.objectContaining({
					NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
					NODE_OPTIONS: '--dns-result-order=ipv4first',
					PERPLEXITY_API_KEY: 'secret-token-value',
				}),
				namespace: 'perplexity',
				transport: 'stdio',
			}),
			'stdio',
		);
	});

	it('passes mediated placeholder env values through to stdio MCP transports', async () => {
		const createTransport = vi.fn(() => dummyTransport);
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createUpstreamMcpTransport: createTransport,
			servers: [
				{
					args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
					command: 'npx',
					env: {
						PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder',
					},
					namespace: 'perplexity',
					transport: 'stdio',
				},
			],
		});

		await expect(
			runtime.listTools({ agentScopeId: 'agent-scope-a', namespace: 'perplexity' }),
		).resolves.toEqual([]);

		expect(createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
				command: 'npx',
				env: expect.objectContaining({
					PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder',
				}),
				namespace: 'perplexity',
				transport: 'stdio',
			}),
			'stdio',
		);
	});

	it('preserves gateway Python and uv runtime env for stdio MCP servers', async () => {
		vi.stubEnv('REQUESTS_CA_BUNDLE', '/run/gondolin/ca-certificates.crt');
		vi.stubEnv('SSL_CERT_FILE', '/run/gondolin/ca-certificates.crt');
		vi.stubEnv('UV_CACHE_DIR', '/work/cache/uv');
		const createTransport = vi.fn(() => dummyTransport);
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: [] })),
		};
		const runtime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createUpstreamMcpTransport: createTransport,
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
			createUpstreamMcpTransport: vi.fn(() => dummyTransport),
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
});
