import { PortalCallResultSchema, PortalListResultSchema } from '@agent-vm/agent-portal-sdk';
import type { ToolPortalMcpProjection } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { createFakeMcpProviderBackend } from '../../../../tests/harness/agent-portal/fake-mcp-provider-server.js';
import { createToolPortalInProcessEntryPoint, type ToolPortalOperationOptions } from './index.js';

const toolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	profiles: {
		'code-builder': {
			capabilities: {
				github: {
					backend: { kind: 'mcp' },
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

describe('Tool Portal in-process entrypoint', () => {
	it('derives the MCP projection and delegates the four batch operations through SDK contracts', async () => {
		const capturedProjections: ToolPortalMcpProjection[] = [];
		const mcpBackend = createFakeMcpProviderBackend({
			capabilities: [
				{
					description: 'Read issue',
					inputSchema: { properties: { number: { type: 'number' } }, type: 'object' },
					namespace: 'github',
					toolName: 'get_issue',
					value: { number: 42, title: 'Tool Portal proof' },
				},
			],
		});
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			createMcpBackend: (projection) => {
				capturedProjections.push(projection);
				return mcpBackend;
			},
		});

		const listResult = await portal.list({ requests: [{ id: 'list-github' }] });
		const callResult = await portal.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'get-issue',
					namespace: 'github',
					toolName: 'get_issue',
				},
			],
		});

		expect(capturedProjections).toHaveLength(1);
		expect(capturedProjections[0]).toMatchObject({
			agentId: 'agent-a',
			namespaces: { github: expect.any(Object) },
			profile: 'code-builder',
		});
		expect(PortalListResultSchema.parse(listResult)).toMatchObject({ ok: true });
		expect(PortalCallResultSchema.parse(callResult)).toMatchObject({
			items: [
				{
					id: 'get-issue',
					status: 'ok',
					value: { number: 42, title: 'Tool Portal proof' },
				},
			],
			ok: true,
		});
		expect(JSON.stringify(listResult)).not.toContain('mcp_portal_');
	});

	it('rejects model-supplied approval tokens before backend dispatch', async () => {
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			createMcpBackend: () =>
				createFakeMcpProviderBackend({
					capabilities: [],
				}),
		});

		await expect(
			portal.call({
				calls: [
					{
						arguments: { title: 'Write' },
						id: 'create-issue',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
				portalApprovalToken: 'model-token',
			}),
		).rejects.toThrow();
	});

	it('passes cancellation signals through to the selected backend', async () => {
		const abortController = new AbortController();
		const capturedOptions: ToolPortalOperationOptions[] = [];
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			createMcpBackend: () => ({
				call: async (_request, options) => {
					if (options !== undefined) {
						capturedOptions.push(options);
					}
					return PortalCallResultSchema.parse({ items: [], ok: true });
				},
				describe: async () => PortalCallResultSchema.parse({ items: [], ok: true }),
				list: async () => PortalCallResultSchema.parse({ items: [], ok: true }),
				search: async () => PortalCallResultSchema.parse({ items: [], ok: true }),
			}),
		});

		await portal.call(
			{
				calls: [
					{
						arguments: { number: 42 },
						id: 'get-issue',
						namespace: 'github',
						toolName: 'get_issue',
					},
				],
			},
			{ signal: abortController.signal },
		);

		expect(capturedOptions).toEqual([{ signal: abortController.signal }]);
	});
});
