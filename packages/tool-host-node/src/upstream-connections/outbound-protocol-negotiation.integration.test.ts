import { rm } from 'node:fs/promises';

import { createPortalAgentIdentity } from '@agent-collaboration/tool-access/authorization';
import { startNodeHost, createNodeProviderRuntime } from '@agent-collaboration/tool-host-node';
import { Client as OldClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as OldHttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport as LegacyTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startLegacySseProvider } from '#node-host/test-fixtures/legacy-sse-provider-fixture';
import {
	connectClient,
	decodedResult,
	successfulOutput,
	fixtureConfig,
	fixtureDirectory,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';
import { startFakeUpstreamMcpServer } from '#node-host/testing/fake-upstream-mcp-server';

function legacyTransport(value: unknown): value is LegacyTransport {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'send' in value &&
		typeof value.send === 'function' &&
		'close' in value &&
		typeof value.close === 'function'
	);
}

// Decided row10b: outbound compatibility must not relax the modern-only inbound route.
describe('production Node outbound version negotiation', () => {
	it('offers and calls modern and old-only providers at startup and after real scope reconnect, refusing an old inbound client', async () => {
		const directory = await fixtureDirectory();
		const modern = await startFakeUpstreamMcpServer();
		const legacy = await startControlledProvider('old-only');
		const config = fixtureConfig(directory, [modern.url, legacy.url]);
		const profile = config.profiles['profile-a'];
		if (profile === undefined) throw new Error('Missing complete caller profile.');
		const policy = profile.profile.namespaces['alpha'];
		if (policy === undefined) throw new Error('Missing modern policy.');
		profile.profile.namespaces['alpha'] = {
			...policy,
			calls: {
				kind: 'selectors',
				withoutApproval: { allow: ['read_thing'], deny: [] },
				requiresApproval: { allow: [], deny: [] },
			},
		};
		profile.profile.namespaces['beta'] = { ...policy };
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({
			configPath,
			secrets: { resolve: async () => 'test-only-secret' },
		});
		if (host.http === undefined) throw new Error('Missing actual HTTP listener.');
		const connected = await connectClient(host.http.endpoint, 'credential-a');
		const oldClient = new OldClient({ name: 'row10-old-client', version: '1' });
		try {
			const listed = successfulOutput(
				await connected.client.callTool({
					name: 'mcp_portal_list',
					arguments: { requests: [{ id: 'both' }] },
				}),
				'both',
			);
			const offered = z
				.object({ tools: z.array(z.object({ namespace: z.string(), toolName: z.string() })) })
				.parse(listed);
			expect(offered.tools).toEqual(
				expect.arrayContaining([
					{ namespace: 'alpha', toolName: 'read_thing' },
					{ namespace: 'beta', toolName: 'read' },
				]),
			);
			expect(modern.calls).toHaveLength(0);
			expect(legacy.effects).toHaveLength(0);
			const request = {
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'modern',
							namespace: 'alpha',
							toolName: 'read_thing',
							arguments: { title: 'modern once' },
						},
						{ id: 'legacy', namespace: 'beta', toolName: 'read', arguments: { value: 17 } },
					],
				},
			};
			const served = await connected.client.callTool(request);
			expect(served['_meta']?.['io.modelcontextprotocol/serverInfo']).toEqual({
				name: 'tool-host-node',
				version: '0.0.153',
			});
			process.stdout.write(`${JSON.stringify({ boundaryResult: served })}\n`);
			expect(decodedResult(served)).toMatchObject({ ok: true });
			expect(modern.calls).toEqual([
				{ name: 'read_thing', argumentsValue: { title: 'modern once' } },
			]);
			expect(
				legacy.effects.map(({ name, arguments: args }) => ({ name, arguments: args })),
			).toEqual([{ name: 'read', arguments: { value: 17 } }]);
			process.stdout.write(
				`${JSON.stringify({ phase: 'startup-called', offered: offered.tools, modernEffects: modern.calls.length, oldEffects: legacy.effects.length })}\n`,
			);
			const startupProbes = modern.requests
				.flatMap((record) => record.jsonRpcMethods)
				.filter((method) => method === 'server/discover').length;
			expect(startupProbes).toBeGreaterThan(0);
			await host.composition.closeSession(
				createPortalAgentIdentity({
					agentId: 'agent-a',
					agentScopeId: 'agent-a',
					source: 'mcp-proxy-bearer',
				}),
			);
			const reoffered = successfulOutput(
				await connected.client.callTool({
					name: 'mcp_portal_list',
					arguments: { requests: [{ id: 'reopened' }] },
				}),
				'reopened',
			);
			expect(
				z
					.object({ tools: z.array(z.object({ namespace: z.string(), toolName: z.string() })) })
					.parse(reoffered).tools,
			).toEqual(offered.tools);
			const reconnectRequest = {
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'modern-reconnect',
							namespace: 'alpha',
							toolName: 'read_thing',
							arguments: { title: 'modern reconnect' },
						},
						{
							id: 'legacy-reconnect',
							namespace: 'beta',
							toolName: 'read',
							arguments: { value: 18 },
						},
					],
				},
			};
			expect(decodedResult(await connected.client.callTool(reconnectRequest))).toMatchObject({
				ok: true,
			});
			expect(modern.calls).toEqual([
				{ name: 'read_thing', argumentsValue: { title: 'modern once' } },
				{ name: 'read_thing', argumentsValue: { title: 'modern reconnect' } },
			]);
			expect(
				legacy.effects.map(({ name, arguments: args }) => ({ name, arguments: args })),
			).toEqual([
				{ name: 'read', arguments: { value: 17 } },
				{ name: 'read', arguments: { value: 18 } },
			]);
			const methods = modern.requests.flatMap((record) => record.jsonRpcMethods);
			expect(methods).not.toContain('initialize');
			expect(modern.requests.filter((record) => record.method === 'GET')).toHaveLength(0);
			expect(methods.filter((method) => method === 'server/discover').length).toBeGreaterThan(
				startupProbes,
			);
			expect(legacy.protocolAttempts.map((entry) => entry.method)).toContain('server/discover');
			expect(legacy.negotiatedVersions).toEqual(['2025-11-25', '2025-11-25', '2025-11-25']);
			const oldTransport: unknown = new OldHttpTransport(host.http.endpoint, {
				requestInit: { headers: { Authorization: 'Bearer credential-a' } },
			});
			if (!legacyTransport(oldTransport)) throw new Error('Invalid old-client transport.');
			await expect(oldClient.connect(oldTransport)).rejects.toThrow();
			expect(modern.calls).toHaveLength(2);
			expect(legacy.effects).toHaveLength(2);
			process.stdout.write(
				`${JSON.stringify({ modern: modern.requests, legacy: legacy.protocolAttempts, legacyVersions: legacy.negotiatedVersions, modernEffects: modern.calls, legacyEffects: legacy.effects })}\n`,
			);
		} finally {
			await Promise.all([connected.client.close(), oldClient.close()]);
			await host.retire();
			await modern.close();
			await legacy.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 20000);
});

it('retains real auto-http fallback to legacy HTTP+SSE with GET/POST credentials and progress', async () => {
	const legacy = await startLegacySseProvider();
	const events: unknown[] = [];
	const runtime = createNodeProviderRuntime({
		servers: [
			{
				namespace: 'sse',
				transport: 'auto-http',
				url: legacy.url,
				headers: { Authorization: 'Bearer legacy-sse-test', 'x-selected-binding': 'selected-sse' },
			},
		],
	});
	try {
		expect(
			(await runtime.listTools({ agentScopeId: 'sse-scope', namespace: 'sse' })).map(
				(tool) => tool.name,
			),
		).toEqual(['read']);
		expect(
			await runtime.callTool({
				agentScopeId: 'sse-scope',
				namespace: 'sse',
				toolName: 'read',
				arguments: { value: 31 },
				onEvent: (event) => {
					events.push(event);
				},
			}),
		).toMatchObject({ content: [{ type: 'text', text: 'legacy SSE read once' }] });
		expect(legacy.effects).toEqual([{ name: 'read', arguments: { value: 31 } }]);
		expect(events).toEqual([
			{ kind: 'progress', progress: 1, total: 1, message: 'legacy network progress' },
		]);
		expect(
			legacy.requests.some((record) => record.httpMethod === 'POST' && record.path === '/sse'),
		).toBe(true);
		expect(
			legacy.requests.some((record) => record.httpMethod === 'GET' && record.path === '/sse'),
		).toBe(true);
		expect(
			legacy.requests.some((record) => record.httpMethod === 'POST' && record.path === '/messages'),
		).toBe(true);
		expect(
			legacy.requests.every(
				(record) =>
					record.authorization === 'Bearer legacy-sse-test' &&
					record.selectedHeader === 'selected-sse',
			),
		).toBe(true);
		process.stdout.write(
			`${JSON.stringify({ sseOnly: legacy.requests, effects: legacy.effects, progress: events })}\n`,
		);
	} finally {
		await runtime.closeAgentScope('sse-scope');
		await legacy.close();
	}
}, 20000);

it('stamps our own direct-response envelope while preserving nested upstream vendor and producer data', async () => {
	const directory = await fixtureDirectory();
	const modern = await startFakeUpstreamMcpServer({
		toolResultByToolName: {
			read_thing: {
				_meta: { 'provider/vendor': 'direct-vendor-canary' },
				content: [{ type: 'text', text: 'direct producer result' }],
				structuredContent: { source: 'upstream' },
			},
		},
	});
	const legacy = await startControlledProvider('unused-legacy');
	const config = fixtureConfig(directory, [modern.url, legacy.url]);
	const profile = config.profiles['profile-a'];
	const policy = profile?.profile.namespaces['alpha'];
	if (profile === undefined || policy === undefined) throw new Error('Missing direct policy.');
	profile.profile.namespaces['alpha'] = {
		...policy,
		calls: {
			kind: 'selectors',
			withoutApproval: { allow: ['read_thing'], deny: [] },
			requiresApproval: { allow: [], deny: [] },
		},
	};
	const host = await startNodeHost({
		configPath: await writeFixtureConfig(config, directory),
		secrets: { resolve: async () => 'test-only-secret' },
	});
	if (host.http === undefined) throw new Error('Missing direct HTTP listener.');
	const endpoint = new URL(host.http.endpoint);
	endpoint.searchParams.set('tools', 'direct');
	const client = await connectClient(endpoint, 'credential-a');
	try {
		const tools = await client.client.listTools();
		const tool = tools.tools.find((entry) => entry.name.startsWith('alpha__read_thing__'));
		if (tool === undefined) throw new Error('Modern direct tool is missing.');
		const result = await client.client.callTool({
			name: tool.name,
			arguments: { title: 'direct once' },
		});
		expect(result['_meta']?.['io.modelcontextprotocol/serverInfo']).toEqual({
			name: 'tool-host-node',
			version: '0.0.153',
		});
		const value = z
			.object({
				result: z.object({
					_meta: z.record(z.string(), z.unknown()),
					content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
					structuredContent: z.object({ source: z.literal('upstream') }),
				}),
			})
			.parse(successfulOutput(result, 'catalog-call'));
		expect(value.result['_meta']).toEqual({
			'provider/vendor': 'direct-vendor-canary',
			'io.modelcontextprotocol/serverInfo': { name: 'portal-upstream-fixture', version: '1.0.0' },
		});
		expect(value.result.content).toEqual([{ type: 'text', text: 'direct producer result' }]);
		expect(modern.calls).toEqual([
			{ name: 'read_thing', argumentsValue: { title: 'direct once' } },
		]);
		expect(legacy.effects).toHaveLength(0);
		process.stdout.write(
			`${JSON.stringify({ directEnvelope: result['_meta'], nestedProvider: value.result, effects: modern.calls })}\n`,
		);
	} finally {
		await client.client.close();
		await host.retire();
		await modern.close();
		await legacy.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 20000);
