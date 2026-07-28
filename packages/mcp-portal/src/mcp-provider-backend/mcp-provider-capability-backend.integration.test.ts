import { PortalCallResultSchema } from '@agent-vm/agent-portal-sdk';
import { ToolPortalMcpProjectionSchema } from '@agent-vm/config-contracts';
import { createMcpProviderCapabilityBackend } from '@agent-vm/mcp-portal/mcp-provider-backend';
import { describe, expect, it, vi } from 'vitest';

import { createPortalCore } from '../core/index.js';
import {
	createFakeUpstreamTools,
	fakeUpstreamNamespace,
} from '../testing/fake-upstream-mcp-server.js';
import {
	createUpstreamMcpClientRuntime,
	type UpstreamMcpClientLike,
} from '../upstream-mcp-client-runtime.js';

describe('MCP provider capability backend integration', () => {
	it('calls a projected read tool through the real MCP client runtime and gates writes', async () => {
		const calls: unknown[] = [];
		const client: UpstreamMcpClientLike = {
			callTool: vi.fn(async (params) => {
				calls.push({ argumentsValue: params.arguments, name: params.name });
				return { structuredContent: { name: params.name, ok: true } };
			}),
			close: vi.fn(),
			connect: vi.fn(),
			listTools: vi.fn(async () => ({ tools: createFakeUpstreamTools() })),
		};
		const upstreamRuntime = createUpstreamMcpClientRuntime({
			createClient: () => client,
			createTransport: vi.fn(() => ({})),
			servers: [
				{
					headers: {},
					namespace: fakeUpstreamNamespace,
					transport: 'streamable-http',
					url: 'https://mcp.example.test',
				},
			],
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: (approvalCalls) => ({
				decisionsByCallId: Object.fromEntries(
					approvalCalls.map((call) => [call.id, { kind: 'allow' }]),
				),
			}),
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: upstreamRuntime.callTool,
				closeAgentScope: upstreamRuntime.closeAgentScope,
				closeSession: upstreamRuntime.closeSession,
				listTools: upstreamRuntime.listTools,
			},
			upstreamNamespaces: [fakeUpstreamNamespace],
		});
		const backend = createMcpProviderCapabilityBackend({
			core,
			projection: ToolPortalMcpProjectionSchema.parse({
				agentId: 'agent-a',
				namespaces: {
					[fakeUpstreamNamespace]: {
						calls: {
							requiresApproval: { allow: ['write_thing'], deny: [] },
							withoutApproval: { allow: ['read_thing'], deny: [] },
						},
						tools: { allow: ['read_thing', 'write_thing'], deny: [] },
					},
				},
				profile: 'code-builder',
			}),
		});

		const readResult = await backend.call({
			calls: [
				{
					arguments: { title: 'read me' },
					id: 'read-thing',
					namespace: fakeUpstreamNamespace,
					name: 'read_thing',
				},
			],
		});
		const writeResult = await backend.call({
			calls: [
				{
					arguments: { title: 'write me' },
					id: 'write-thing',
					namespace: fakeUpstreamNamespace,
					name: 'write_thing',
				},
			],
		});

		expect(PortalCallResultSchema.parse(readResult)).toMatchObject({
			items: [
				{
					id: 'read-thing',
					operationId: expect.stringMatching(/\S+/u),
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: 'mcp-provider:agent-a',
					status: 'ok',
					value: {
						namespace: fakeUpstreamNamespace,
						result: { structuredContent: { name: 'read_thing', ok: true } },
						name: 'read_thing',
					},
				},
			],
			ok: true,
		});
		expect(PortalCallResultSchema.parse(writeResult)).toMatchObject({
			items: [
				{
					error: { code: 'approval_required' },
					id: 'write-thing',
					operationId: expect.stringMatching(/\S+/u),
					outcome: {
						certainty: 'proven',
						kind: 'not-dispatched',
						retryClass: 'safe-before-dispatch',
					},
					owningGeneration: 'mcp-provider:agent-a',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(calls).toEqual([
			{
				argumentsValue: { title: 'read me' },
				name: 'read_thing',
			},
		]);

		await core.close();
	});
});
