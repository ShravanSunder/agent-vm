import { expect, it } from 'vitest';

import { createUpstreamMcpClientRuntime } from '#upstream-mcp-connectors/upstream-mcp-client-runtime';

it('passes string header values to host transports while preserving privileged overrides and fetch coercion', async () => {
	// Arrange: Node accepts an optional record value; Worker HeadersInit requires strings.
	let observed: RequestInit['headers'];
	const runtime = createUpstreamMcpClientRuntime({
		servers: [
			{
				namespace: 'headers',
				transport: 'streamable-http',
				url: 'https://headers.invalid/mcp',
				requestInit: { headers: { authorization: 'caller', 'x-optional': undefined } },
				headers: { authorization: 'privileged' },
			},
		],
		createClient: () => ({
			connect: async () => {},
			listTools: async () => ({ tools: [] }),
			callTool: async () => ({}),
			close: async () => {},
		}),
		createUpstreamMcpTransport: (server) => {
			observed = server.requestInit?.headers;
			return { start: async () => {}, send: async () => {}, close: async () => {} };
		},
	});
	try {
		// Act: use the real public runtime-to-injected-host boundary, without network I/O.
		await runtime.listTools({ agentScopeId: 'agent', namespace: 'headers' });
		// Assert: literal values match Headers' string coercion, with the privileged binding winning.
		expect(observed).toEqual({ authorization: 'privileged', 'x-optional': 'undefined' });
	} finally {
		await runtime.closeAgentScope('agent');
	}
});
