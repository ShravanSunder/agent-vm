import {
	startFakeUpstreamMcpServer,
	fakeUpstreamNamespace,
} from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import { PortalCallResultSchema } from '@agent-vm/agent-portal-sdk';
import { ToolPortalMcpProjectionSchema } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { createManagedMcpProviderBackendFactoryFromConfig } from '#gateway-runtime/backends/managed-mcp-provider-backend';

describe('managed MCP provider resource boundary', () => {
	it('uses the actual connector for allowed reads and refuses a visible unapproved write before any effect', async () => {
		const server = await startFakeUpstreamMcpServer();
		const factory = await createManagedMcpProviderBackendFactoryFromConfig({
			mcpConfig: {
				schemaVersion: 1,
				providers: {
					fixture: {
						kind: 'mcp',
						namespace: fakeUpstreamNamespace,
						discovery: {},
						secretPolicies: {},
						transport: {
							kind: 'streamable-http',
							url: server.url,
							headers: {},
							requiredEgressHosts: [],
						},
					},
				},
			},
			resolveSecret: async () => {
				throw new Error('No credentials required by controlled provider');
			},
		});
		try {
			const namespacePolicy = {
				tools: { allow: ['read_thing', 'write_thing'], deny: [] },
				calls: {
					withoutApproval: { allow: ['read_thing'], deny: [] },
					requiresApproval: { allow: ['write_thing'], deny: [] },
				},
			};
			const projection = ToolPortalMcpProjectionSchema.parse({
				agentId: 'agent-a',
				profile: 'code-builder',
				namespaces: { [fakeUpstreamNamespace]: namespacePolicy },
			});
			const backend = factory.createBackend(projection);
			const result = PortalCallResultSchema.parse(
				await backend.call({
					calls: [
						{
							id: 'read',
							namespace: fakeUpstreamNamespace,
							name: 'read_thing',
							arguments: { title: 'Permitted control' },
						},
						{
							id: 'write',
							namespace: fakeUpstreamNamespace,
							name: 'write_thing',
							arguments: { title: 'Unapproved write' },
						},
					],
				}),
			);
			expect(result).toMatchObject({
				ok: false,
				items: [
					{
						id: 'read',
						status: 'ok',
						owningGeneration: 'mcp-provider:agent-a',
						outcome: {
							kind: 'completed',
							completion: 'succeeded',
							certainty: 'proven',
							retryClass: 'forbidden',
						},
						value: {
							namespace: fakeUpstreamNamespace,
							name: 'read_thing',
							result: { structuredContent: { name: 'read_thing', ok: true } },
						},
					},
					{
						id: 'write',
						status: 'error',
						error: { code: 'approval_required' },
						owningGeneration: 'mcp-provider:agent-a',
						outcome: {
							kind: 'not-dispatched',
							certainty: 'proven',
							retryClass: 'safe-before-dispatch',
						},
					},
				],
			});
			expect(server.calls.map((call) => call.name)).toEqual(['read_thing']);
		} finally {
			await factory.close();
			await server.close();
		}
	});
});
