import { describe, it, expect } from 'vitest';

import { createUpstreamMcpClientRuntime } from '#upstream-mcp-connectors/upstream-mcp-client-runtime';
import type { UpstreamMcpClientLike } from '#upstream-mcp-connectors/upstream-mcp-protocol';

describe('connector credential redaction at callback boundaries', () => {
	it('redacts exact configured credentials from close diagnostics and progress', async () => {
		const canary = 'opaque-close-canary-83';
		const diagnostics: string[] = [];
		const progress: unknown[] = [];
		const client: UpstreamMcpClientLike = {
			connect: async () => {},
			listTools: async () => ({ tools: [] }),
			callTool: async (_params, _schema, options) => {
				options?.onprogress?.({ progress: 1, message: canary });
				return {};
			},
			close: async () => {
				throw new Error(`close ${canary}`);
			},
		};
		const runtime = createUpstreamMcpClientRuntime({
			servers: [
				{
					namespace: 'provider',
					transport: 'streamable-http',
					url: 'https://provider.example.test',
					headers: { 'x-provider-key': canary },
				},
			],
			createClient: () => client,
			createUpstreamMcpTransport: () => ({
				start: async () => {},
				send: async () => {},
				close: async () => {},
			}),
			onCloseError: (error) => {
				diagnostics.push(error.message);
			},
		});
		await runtime.callTool({
			agentScopeId: 'caller',
			namespace: 'provider',
			toolName: 'read',
			arguments: {},
			onEvent: (event) => {
				progress.push(event);
			},
		});
		await runtime.closeAgentScope('caller');
		expect.soft(diagnostics).toEqual(['close [REDACTED]']);
		expect.soft(progress).toEqual([{ kind: 'progress', progress: 1, message: '[REDACTED]' }]);
	});
});
