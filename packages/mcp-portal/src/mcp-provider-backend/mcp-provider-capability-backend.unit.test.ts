import {
	PortalCallResultSchema,
	PortalListResultSchema,
	PortalSearchResultSchema,
} from '@agent-vm/agent-portal-sdk';
import { ToolPortalMcpProjectionSchema } from '@agent-vm/config-contracts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { createPortalCore } from '../core/index.js';
import { createMcpProviderCapabilityBackend } from './index.js';

const githubTools = [
	{
		description: 'Read issue',
		inputSchema: {
			properties: { number: { type: 'number' } },
			required: ['number'],
			type: 'object',
		},
		name: 'get_issue',
	},
	{
		description: 'Create issue',
		inputSchema: {
			properties: { title: { type: 'string' } },
			required: ['title'],
			type: 'object',
		},
		name: 'create_issue',
	},
] satisfies readonly Tool[];

function createBackendFixture(options?: {
	readonly callUpstreamTool?: (call: {
		readonly arguments: Record<string, unknown>;
		readonly namespace: string;
		readonly toolName: string;
	}) => Promise<unknown>;
	readonly listTools?: (props: { readonly namespace: string }) => Promise<readonly Tool[]>;
}): ReturnType<typeof createMcpProviderCapabilityBackend> {
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
			callUpstreamTool: vi.fn(
				options?.callUpstreamTool ??
					(async (call) => ({
						arguments: call.arguments,
						ok: true,
						upstreamTool: `${call.namespace}.${call.toolName}`,
					})),
			),
			closeAgentScope: vi.fn(),
			listTools: vi.fn(
				options?.listTools ??
					(async ({ namespace }) => (namespace === 'github' ? githubTools : [])),
			),
		},
		upstreamNamespaces: ['github', 'linear'],
	});
	return createMcpProviderCapabilityBackend({
		core,
		projection: ToolPortalMcpProjectionSchema.parse({
			agentId: 'agent-a',
			namespaces: {
				github: {
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue', 'create_issue'], deny: [] },
				},
			},
			profile: 'code-builder',
		}),
	});
}

describe('MCP provider capability backend', () => {
	it('includes managed session provenance in upstream MCP agent scope ids', async () => {
		const observedAgentScopeIds: string[] = [];
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
				callUpstreamTool: vi.fn(async (call) => {
					observedAgentScopeIds.push(call.agentScopeId);
					return {
						arguments: call.arguments,
						ok: true,
						upstreamTool: `${call.namespace}.${call.toolName}`,
					};
				}),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async ({ namespace }) => (namespace === 'github' ? githubTools : [])),
			},
			upstreamNamespaces: ['github'],
		});
		const projection = ToolPortalMcpProjectionSchema.parse({
			agentId: 'agent-a',
			namespaces: {
				github: {
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue'], deny: [] },
				},
			},
			profile: 'code-builder',
		});
		const sessionABackend = createMcpProviderCapabilityBackend({
			core,
			projection,
			sessionKey: 'session-a',
		});
		const sessionBBackend = createMcpProviderCapabilityBackend({
			core,
			projection,
			sessionKey: 'session-b',
		});

		await sessionABackend.call({
			calls: [
				{
					arguments: { number: 1 },
					id: 'session-a-read',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});
		await sessionBBackend.call({
			calls: [
				{
					arguments: { number: 2 },
					id: 'session-b-read',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(observedAgentScopeIds).toEqual([
			'mcp-provider:agent-a\nsession-a',
			'mcp-provider:agent-a\nsession-b',
		]);
	});

	it('lists and searches projected upstream MCP capabilities without portal tool names', async () => {
		const backend = createBackendFixture();

		const listResult = await backend.list({ requests: [{ id: 'list-tools' }] });
		const searchResult = await backend.search({
			requests: [{ id: 'search-tools', query: 'issue', schemaDetail: 'summary' }],
		});

		expect(PortalListResultSchema.parse(listResult)).toMatchObject({
			items: [
				{
					id: 'list-tools',
					status: 'ok',
				},
			],
			ok: true,
		});
		expect(PortalSearchResultSchema.parse(searchResult)).toMatchObject({
			items: [
				{
					id: 'search-tools',
					status: 'ok',
				},
			],
			ok: true,
		});
		expect(JSON.stringify(listResult)).toContain('get_issue');
		expect(JSON.stringify(listResult)).not.toContain('linear');
		expect(JSON.stringify(listResult)).not.toContain('mcp_portal_');
	});

	it('does not broaden explicit namespace filters with no projected intersection', async () => {
		const backend = createBackendFixture();

		const listResult = await backend.list({
			requests: [{ id: 'list-linear', namespaces: ['linear'] }],
		});
		const searchResult = await backend.search({
			requests: [{ id: 'search-linear', namespaces: ['linear'], query: 'issue' }],
		});

		expect(PortalListResultSchema.parse(listResult)).toMatchObject({
			items: [
				{
					id: 'list-linear',
					status: 'ok',
					value: { namespaces: [], tools: [] },
				},
			],
			ok: true,
		});
		expect(PortalSearchResultSchema.parse(searchResult)).toMatchObject({
			items: [
				{
					id: 'search-linear',
					status: 'ok',
					value: { tools: [] },
				},
			],
			ok: true,
		});
		expect(JSON.stringify(listResult)).not.toContain('get_issue');
		expect(JSON.stringify(searchResult)).not.toContain('get_issue');
	});

	it('filters diagnostics from namespaces outside the Tool Portal projection', async () => {
		const backend = createBackendFixture({
			listTools: async ({ namespace }) => {
				if (namespace === 'linear') {
					throw new Error('linear discovery failed');
				}
				return githubTools;
			},
		});

		const result = await backend.list({ requests: [{ id: 'list-tools' }] });

		expect(PortalListResultSchema.parse(result)).toMatchObject({ ok: true });
		expect(JSON.stringify(result)).toContain('github');
		expect(JSON.stringify(result)).not.toContain('linear');
	});

	it('normalizes allowed calls through MCP Portal core and preserves item ids', async () => {
		const backend = createBackendFixture();

		const result = await backend.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					id: 'read-issue',
					status: 'ok',
					value: {
						namespace: 'github',
						result: {
							arguments: { number: 42 },
							ok: true,
							upstreamTool: 'github.get_issue',
						},
						name: 'get_issue',
					},
				},
			],
			ok: true,
		});
	});

	it('maps upstream call failures to model-safe error codes', async () => {
		const backend = createBackendFixture({
			callUpstreamTool: async () => {
				throw new Error(
					'Missing environment secret PERPLEXITY_API_KEY at /Users/alice/.config/tool using https://api.example.test via /usr/local/bin/provider',
				);
			},
		});

		const result = await backend.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'execution_failed',
						message: 'Capability execution failed.',
					},
					id: 'read-issue',
					status: 'error',
				},
			],
			ok: false,
		});
		const serializedResult = JSON.stringify(result);
		expect(serializedResult).not.toContain('PERPLEXITY_API_KEY');
		expect(serializedResult).not.toContain('/Users/alice');
		expect(serializedResult).not.toContain('api.example.test');
		expect(serializedResult).not.toContain('/usr/local/bin/provider');
	});

	it('maps upstream input validation failures to schema errors on the capability surface', async () => {
		const backend = createBackendFixture();

		const result = await backend.call({
			calls: [
				{
					arguments: { number: 'not-a-number' },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'validation_failed',
						message: 'Capability input did not match the expected schema.',
					},
					id: 'read-issue',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(JSON.stringify(result)).toContain('validation_failed');
		expect(JSON.stringify(result)).not.toContain('Capability execution failed');
	});

	it('requires approval for projected write calls and rejects model-supplied tokens', async () => {
		const backend = createBackendFixture();

		await expect(
			backend.call({
				calls: [
					{
						arguments: { title: 'Write' },
						id: 'create-issue',
						namespace: 'github',
						name: 'create_issue',
					},
				],
			}),
		).resolves.toMatchObject({
			items: [
				{
					error: {
						code: 'approval_required',
					},
					id: 'create-issue',
					status: 'error',
				},
			],
			ok: false,
		});

		await expect(
			backend.call({
				calls: [
					{
						arguments: { title: 'Write' },
						id: 'create-issue',
						namespace: 'github',
						name: 'create_issue',
					},
				],
				portalApprovalToken: 'model-token',
			}),
		).rejects.toThrow();
	});
});
