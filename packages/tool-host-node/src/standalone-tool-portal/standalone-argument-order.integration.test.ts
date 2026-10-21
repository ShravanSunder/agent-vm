import { ToolPortalMcpClient } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import { createNodeToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';
import { expect, it } from 'vitest';

import { startStandaloneToolPortalMcpHttpServer } from '#node-host/standalone-tool-portal/standalone-http-servers';
import {
	startControlledProvider,
	toolInputSchema,
} from '#node-host/test-fixtures/node-host-fixture';
import {
	createStandaloneHostFixture,
	standaloneCredentials,
} from '#node-host/test-fixtures/standalone-host-fixture';

it('dispatches equal arguments when the real host fact projection reverses object key order', async () => {
	const provider = await startControlledProvider('argument-order', [
		{
			name: 'read',
			inputSchema: {
				...toolInputSchema,
				properties: { value: { type: 'number' }, note: { type: 'string' } },
			},
		},
	]);
	// A valid resource fact projection can normalize object insertion order without changing its JSON value.
	const fixture = await createStandaloneHostFixture(
		provider,
		'example',
		undefined,
		undefined,
		(argumentsValue) => Object.fromEntries(Object.entries(argumentsValue).toReversed()),
	);
	const host = await startStandaloneToolPortalMcpHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
		artifactReader: fixture.artifactReader,
	});
	const client = new ToolPortalMcpClient({
		transport: createNodeToolPortalMcpTransport({
			kind: 'http',
			endpoint: host.endpoint,
			authorization: 'credential-agent-a',
		}),
	});
	try {
		await client.connect();
		const control = await client.call({
			calls: [{ id: 'single-key', namespace: 'example', name: 'read', arguments: { value: 42 } }],
		});
		expect(control.ok).toBe(true);
		expect(provider.effects).toHaveLength(1);
		const result = await client.call({
			calls: [
				{
					id: 'reordered-keys',
					namespace: 'example',
					name: 'read',
					arguments: { value: 42, note: 'same value' },
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(result.items[0]?.outcome.kind).toBe('completed');
		expect(provider.effects).toHaveLength(2);
		expect(provider.effects[1]?.arguments).toEqual({ value: 42, note: 'same value' });
	} finally {
		await client.close();
		await host.retire();
		await fixture.close();
		await provider.close();
	}
});
