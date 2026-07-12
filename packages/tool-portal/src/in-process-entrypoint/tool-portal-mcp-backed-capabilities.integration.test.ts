import { PortalCallResultSchema } from '@agent-vm/agent-portal-sdk';
import { createPortalCore } from '@agent-vm/mcp-portal/core';
import { createMcpProviderCapabilityBackend } from '@agent-vm/mcp-portal/mcp-provider-backend';
import { describe, expect, it, vi } from 'vitest';

import { createToolPortalInProcessEntryPoint } from './index.js';

const githubTools = [
	{
		description: 'Read issue',
		inputSchema: {
			properties: { number: { type: 'number' } },
			required: ['number'],
			type: 'object' as const,
		},
		name: 'get_issue',
	},
	{
		description: 'Create issue',
		inputSchema: {
			properties: { title: { type: 'string' } },
			required: ['title'],
			type: 'object' as const,
		},
		name: 'create_issue',
	},
];

const toolPortalConfig = {
	agents: { 'agent-a': { profile: 'code-builder' } },
	profiles: {
		'code-builder': {
			capabilities: {
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue', 'create_issue'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
};

describe('Tool Portal MCP-backed capabilities integration', () => {
	it('routes allowed MCP-backed calls through the MCP backend and gates approval-required calls', async () => {
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: (calls) => ({
				decisionsByCallId: Object.fromEntries(calls.map((call) => [call.id, { kind: 'allow' }])),
			}),
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(async (call) => ({
					arguments: call.arguments,
					ok: true,
					upstreamTool: `${call.namespace}.${call.name}`,
				})),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async ({ namespace }) => (namespace === 'github' ? githubTools : [])),
			},
			upstreamNamespaces: ['github'],
		});
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			createMcpBackend: (projection) =>
				createMcpProviderCapabilityBackend({
					core,
					projection,
				}),
		});

		const readResult = await portal.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});
		const writeResult = await portal.call({
			calls: [
				{
					arguments: { title: 'Write issue' },
					id: 'write-issue',
					namespace: 'github',
					name: 'create_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(readResult)).toMatchObject({
			items: [{ id: 'read-issue', status: 'ok' }],
			ok: true,
		});
		expect(writeResult).toMatchObject({
			items: [{ error: { code: 'approval_required' }, id: 'write-issue', status: 'error' }],
			ok: false,
		});
		expect(JSON.stringify(readResult)).not.toContain('mcp_portal_');

		await core.close();
	});
});
