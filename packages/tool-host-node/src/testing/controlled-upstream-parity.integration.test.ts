import { createUpstreamMcpClientRuntime } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import { startFakeUpstreamMcpServer as startOldOnlyServer } from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CallToolResultSchema as LegacyCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNodeHttpUpstreamTransport } from '#node-host/stdio-upstream-servers/node-upstream-transports';
import {
	createFakeUpstreamTools,
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
	type FakeUpstreamMcpServerOptions,
	type StartedFakeUpstreamMcpServer,
} from '#node-host/testing/fake-upstream-mcp-server';

interface ControlledUpstreamObservation {
	readonly tools: unknown;
	readonly result: unknown;
	readonly events: readonly unknown[];
	readonly calls: StartedFakeUpstreamMcpServer['calls'];
	readonly toolResults: readonly unknown[];
	readonly listedTools: readonly unknown[];
	readonly requests: StartedFakeUpstreamMcpServer['requests'];
}

// The modern handler stamps its own reserved producer identity; vendor metadata remains exact.
function withoutModernServerIdentity(result: unknown): unknown {
	if (
		typeof result !== 'object' ||
		result === null ||
		Array.isArray(result) ||
		!('_meta' in result)
	)
		return result;
	const record = z.record(z.string(), z.unknown()).parse(result);
	const metadata = z.record(z.string(), z.unknown()).parse(record['_meta']);
	expect(metadata['io.modelcontextprotocol/serverInfo']).toEqual({
		name: 'portal-upstream-fixture',
		version: '1.0.0',
	});
	const vendorMetadata = Object.fromEntries(
		Object.entries(metadata).filter(([key]) => key !== 'io.modelcontextprotocol/serverInfo'),
	);
	const payload = Object.fromEntries(Object.entries(record).filter(([key]) => key !== '_meta'));
	return Object.keys(vendorMetadata).length === 0 ? payload : { ...payload, _meta: vendorMetadata };
}

type ComparisonServer = Pick<
	StartedFakeUpstreamMcpServer,
	'calls' | 'authorizationHeaders' | 'close' | 'firstListToolsRequest' | 'requests' | 'port' | 'url'
> & { readonly listedTools: readonly unknown[]; readonly toolResults: readonly unknown[] };
async function oldComparisonServer(
	options: FakeUpstreamMcpServerOptions,
): Promise<ComparisonServer> {
	const { toolResultByToolName, ...otherOptions } = options;
	return await startOldOnlyServer({
		...otherOptions,
		...(toolResultByToolName === undefined
			? {}
			: {
					toolResultByToolName: Object.fromEntries(
						Object.entries(toolResultByToolName).map(([name, result]) => [
							name,
							LegacyCallToolResultSchema.parse(result),
						]),
					),
				}),
	});
}

// The independent old-only source is retained from accepted 40a4ec5b, not implemented through this entry.
async function observeControlledServer(
	factory: (options: FakeUpstreamMcpServerOptions) => Promise<ComparisonServer>,
	options: FakeUpstreamMcpServerOptions,
): Promise<ControlledUpstreamObservation> {
	const server = await factory(options);
	const runtime = createUpstreamMcpClientRuntime({
		servers: [
			{
				namespace: fakeUpstreamNamespace,
				transport: 'streamable-http',
				url: server.url,
				headers: { authorization: 'Bearer controlled-fixture-canary' },
			},
		],
		createUpstreamMcpTransport: createNodeHttpUpstreamTransport,
	});
	const events: unknown[] = [];
	try {
		const [tools] = await Promise.all([
			runtime.listTools({ agentScopeId: 'fixture-caller', namespace: fakeUpstreamNamespace }),
			server.firstListToolsRequest,
		]);
		let result: unknown;
		if (!options.emptyTools) {
			try {
				result = await runtime.callTool({
					agentScopeId: 'fixture-caller',
					namespace: fakeUpstreamNamespace,
					toolName: 'read_thing',
					arguments: { title: 'Unicode ✓' },
					onEvent: (event) => {
						events.push(event);
					},
				});
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				result = { name: error.name, message: error.message };
			}
		}
		expect(new URL(server.url).pathname).toBe('/mcp');
		expect(new URL(server.url).port).toBe(String(server.port));
		expect(server.authorizationHeaders).toContain('Bearer controlled-fixture-canary');
		return {
			tools,
			result,
			events,
			calls: server.calls,
			toolResults: server.toolResults,
			listedTools: server.listedTools,
			requests: server.requests,
		};
	} finally {
		await runtime.closeAgentScope('fixture-caller');
		await server.close();
	}
}

describe('Node workspace controlled upstream entry', () => {
	it.each([
		{ label: 'listing, successful effect and progress', options: { emitProgress: true } },
		{ label: 'empty catalog', options: { emptyTools: true } },
		{
			label: 'description and result overrides',
			options: {
				descriptionByToolName: { read_thing: 'Custom description ✓' },
				toolResultByToolName: {
					read_thing: {
						_meta: { 'provider/example': 'vendor metadata is preserved' },
						content: [{ type: 'text' as const, text: 'custom result' }],
						structuredContent: { ok: true, source: 'controlled' },
					},
				},
			},
		},
		{
			label: 'tool error result without successful effect',
			options: { toolErrorMessageByToolName: { read_thing: 'Controlled tool refusal' } },
		},
		{
			label: 'HTTP failure without a tool result or effect',
			options: { callHttpStatusCode: 429 as const, callHttpStatusToolName: 'read_thing' },
		},
	])('preserves old-only fixture observations for $label', async ({ options }) => {
		// Arrange / Act: both observations use actual listeners, SDK calls and the production Node transport.
		const expected = await observeControlledServer(oldComparisonServer, options);
		const actual = await observeControlledServer(startFakeUpstreamMcpServer, options);
		// Assert
		expect(actual.calls).toEqual(expected.calls);
		const { requests: actualRequests, ...actualValues } = actual;
		const { requests: expectedRequests, ...expectedValues } = expected;
		expect({ ...actualValues, result: withoutModernServerIdentity(actual.result) }).toEqual(
			expectedValues,
		);
		expect(
			actualRequests.every((request) => request.method === 'POST' && request.path === '/mcp'),
		).toBe(true);
		expect(actualRequests.flatMap((request) => request.jsonRpcMethods)).not.toContain('initialize');
		expect(expectedRequests.flatMap((request) => request.jsonRpcMethods)).toContain('initialize');
	});
	it('counts one actual success and records error results separately from successful effects', async () => {
		const server = await startFakeUpstreamMcpServer({
			toolErrorMessageByToolName: { write_thing: 'controlled refusal' },
		});
		const runtime = createUpstreamMcpClientRuntime({
			servers: [
				{ namespace: fakeUpstreamNamespace, transport: 'streamable-http', url: server.url },
			],
			createUpstreamMcpTransport: createNodeHttpUpstreamTransport,
		});
		try {
			expect(fakeUpstreamNamespace).toBe('upstream-mock');
			expect(createFakeUpstreamTools().map((tool) => tool.name)).toEqual([
				'read_thing',
				'write_thing',
			]);
			await runtime.callTool({
				agentScopeId: 'counted-caller',
				namespace: fakeUpstreamNamespace,
				toolName: 'read_thing',
				arguments: { title: 'read once' },
			});
			await expect(
				runtime.callTool({
					agentScopeId: 'counted-caller',
					namespace: fakeUpstreamNamespace,
					toolName: 'write_thing',
					arguments: { title: 'denied write' },
				}),
			).rejects.toMatchObject({ details: { failureClass: 'tool_error' } });
			expect(server.calls).toEqual([
				{ name: 'read_thing', argumentsValue: { title: 'read once' } },
			]);
			expect(server.toolResults).toHaveLength(2);
			expect(server.toolResults[1]).toEqual({
				content: [{ type: 'text', text: 'controlled refusal' }],
				isError: true,
			});
		} finally {
			await runtime.closeAgentScope('counted-caller');
			await server.close();
		}
	});
	it('keeps the independent old-only server as a modern-client refusal with a working legacy control', async () => {
		const server = await oldComparisonServer({});
		const modern = new Client(
			{ name: 'old-only-negative', version: '1' },
			{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
		);
		const legacyRuntime = createUpstreamMcpClientRuntime({
			servers: [
				{ namespace: fakeUpstreamNamespace, transport: 'streamable-http', url: server.url },
			],
			createUpstreamMcpTransport: createNodeHttpUpstreamTransport,
		});
		try {
			await expect(
				modern.connect(new StreamableHTTPClientTransport(new URL(server.url))),
			).rejects.toThrow();
			expect(server.calls).toEqual([]);
			const tools = await legacyRuntime.listTools({
				agentScopeId: 'permitted-legacy',
				namespace: fakeUpstreamNamespace,
			});
			expect(tools.map((tool) => tool.name)).toEqual(['read_thing', 'write_thing']);
			await legacyRuntime.callTool({
				agentScopeId: 'permitted-legacy',
				namespace: fakeUpstreamNamespace,
				toolName: 'read_thing',
				arguments: { title: 'legacy control' },
			});
			expect(server.calls).toEqual([
				{ name: 'read_thing', argumentsValue: { title: 'legacy control' } },
			]);
			expect(server.requests.flatMap((request) => request.jsonRpcMethods)).toContain(
				'server/discover',
			);
		} finally {
			await modern.close();
			await legacyRuntime.closeAgentScope('permitted-legacy');
			await server.close();
		}
	});
});
