import {
	PortalCallResultSchema,
	PortalBackendDescribeResultSchema,
	PortalBackendListResultSchema,
	PortalBackendSearchResultSchema,
} from '@agent-vm/agent-portal-sdk';
import { ToolPortalMcpProjectionSchema } from '@agent-vm/config-contracts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { createPortalCore } from '../core/index.js';
import { createUpstreamMcpError } from '../upstream-mcp-errors.js';
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
	it('describes a remote MCP tool without an optional output schema', async () => {
		// Arrange
		const backend = createBackendFixture();

		// Act
		const result = await backend.describe({
			requests: [
				{
					id: 'describe-issue',
					includeJsonSchema: true,
					tools: [{ name: 'get_issue', namespace: 'github' }],
				},
			],
		});

		// Assert
		expect(PortalBackendDescribeResultSchema.parse(result)).toMatchObject({
			items: [
				{
					id: 'describe-issue',
					status: 'ok',
					value: {
						tools: [
							{
								inputSchema: expect.objectContaining({ type: 'object' }),
								name: 'get_issue',
								namespace: 'github',
							},
						],
					},
				},
			],
			ok: true,
		});
		expect(JSON.stringify(result)).not.toContain('outputSchema');
	});

	it('preserves direct Hermes scope identity while allowing Tool Portal service scope identity', () => {
		// Arrange
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
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => githubTools),
			},
			upstreamNamespaces: ['github'],
		});
		const createAgentScope = vi.spyOn(core, 'createAgentScope');
		const projection = ToolPortalMcpProjectionSchema.parse({
			agentId: 'agent-a',
			namespaces: {},
			profile: 'code-builder',
		});

		// Act
		createMcpProviderCapabilityBackend({ core, projection });
		createMcpProviderCapabilityBackend({
			core,
			portalAgentScopeSource: 'tool-portal-service',
			projection,
			sessionKey: 'tool-portal-session',
		});

		// Assert
		expect(createAgentScope).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ source: 'managed-gateway-trusted' }),
		);
		expect(createAgentScope).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				sessionKey: 'tool-portal-session',
				source: 'tool-portal-service',
			}),
		);
	});

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

		expect(PortalBackendListResultSchema.parse(listResult)).toMatchObject({
			items: [
				{
					id: 'list-tools',
					status: 'ok',
				},
			],
			ok: true,
		});
		expect(PortalBackendSearchResultSchema.parse(searchResult)).toMatchObject({
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

		expect(PortalBackendListResultSchema.parse(listResult)).toMatchObject({
			items: [
				{
					id: 'list-linear',
					status: 'ok',
					value: { namespaces: [], tools: [] },
				},
			],
			ok: true,
		});
		expect(PortalBackendSearchResultSchema.parse(searchResult)).toMatchObject({
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

		expect(PortalBackendListResultSchema.parse(result)).toMatchObject({ ok: true });
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

	it('preserves service-owned operation identities supplied through private call options', async () => {
		// Arrange
		const backend = createBackendFixture();
		const operationId = '60000000-0000-4000-8000-000000000006';

		// Act
		const result = PortalCallResultSchema.parse(
			await Reflect.apply(backend.call, backend, [
				{
					calls: [
						{
							arguments: { number: 42 },
							id: 'read-issue',
							name: 'get_issue',
							namespace: 'github',
						},
					],
				},
				{ operationIdsByCallId: { 'read-issue': operationId } },
			]),
		);

		// Assert
		expect(result.items[0]?.operationId).toBe(operationId);
	});

	it('preserves a complete private operation identity map for a standalone batch', async () => {
		// Arrange
		const backend = createBackendFixture();
		const operationIdsByCallId = {
			'read-first': '60000000-0000-4000-8000-000000000006',
			'read-second': '70000000-0000-4000-8000-000000000007',
		};

		// Act
		const result = PortalCallResultSchema.parse(
			await Reflect.apply(backend.call, backend, [
				{
					calls: Object.keys(operationIdsByCallId).map((id, index) => ({
						arguments: { number: index + 1 },
						id,
						name: 'get_issue',
						namespace: 'github',
					})),
				},
				{ operationIdsByCallId },
			]),
		);

		// Assert
		expect(Object.fromEntries(result.items.map((item) => [item.id, item.operationId]))).toEqual(
			operationIdsByCallId,
		);
	});

	it.each([
		{
			name: 'missing call id',
			operationIdsByCallId: { other: '60000000-0000-4000-8000-000000000006' },
		},
		{
			name: 'extra call id',
			operationIdsByCallId: {
				'read-issue': '60000000-0000-4000-8000-000000000006',
				extra: '70000000-0000-4000-8000-000000000007',
			},
		},
		{
			name: 'invalid operation id',
			operationIdsByCallId: { 'read-issue': 'not-an-operation-id' },
		},
	])('rejects a $name operation identity map before upstream dispatch', async (fixture) => {
		// Arrange
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = createBackendFixture({ callUpstreamTool });

		// Act / Assert
		await expect(
			Reflect.apply(backend.call, backend, [
				{
					calls: [
						{
							arguments: { number: 42 },
							id: 'read-issue',
							name: 'get_issue',
							namespace: 'github',
						},
					],
				},
				{ operationIdsByCallId: fixture.operationIdsByCallId },
			]),
		).rejects.toThrow('operation identity map');
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});

	it('maps upstream call failures to model-safe error codes', async () => {
		const callUpstreamTool = vi.fn(async () => {
			throw new Error(
				'Missing environment secret PERPLEXITY_API_KEY at /Users/alice/.config/tool using https://api.example.test via /usr/local/bin/provider',
			);
		});
		const backend = createBackendFixture({
			callUpstreamTool,
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
					operationId: expect.stringMatching(/\S+/u),
					outcome: {
						certainty: 'side-effects-and-termination-unknown',
						kind: 'ambiguous',
						retryClass: 'forbidden',
					},
					owningGeneration: 'mcp-provider:agent-a',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(callUpstreamTool).toHaveBeenCalledTimes(1);
		const serializedResult = JSON.stringify(result);
		expect(serializedResult).not.toContain('PERPLEXITY_API_KEY');
		expect(serializedResult).not.toContain('/Users/alice');
		expect(serializedResult).not.toContain('api.example.test');
		expect(serializedResult).not.toContain('/usr/local/bin/provider');
	});

	it('gives the model a safe actionable error for remote MCP authentication failures', async () => {
		// Arrange
		const callUpstreamTool = vi.fn(async () => {
			throw createUpstreamMcpError({
				causeMessage: 'Error POSTing to endpoint: credential detail must not escape',
				elapsedMs: 12,
				failureClass: 'authentication',
				httpStatusCode: 401,
				namespace: 'github',
				operation: 'MCP callTool github.get_issue',
				phase: 'call_tool',
				toolName: 'get_issue',
				transport: { kind: 'streamable-http', url: 'https://provider.example.test/mcp' },
			});
		});
		const backend = createBackendFixture({ callUpstreamTool });

		// Act
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

		// Assert
		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'not_authorized',
						message:
							'Remote capability authentication failed. Ask the operator to verify its provider credential.',
					},
					id: 'read-issue',
					status: 'error',
				},
			],
			ok: false,
		});
		const serializedResult = JSON.stringify(result);
		expect(serializedResult).not.toContain('credential detail');
		expect(serializedResult).not.toContain('provider.example.test');
	});

	it.each([
		{
			expectedCode: 'not_authorized',
			expectedMessage: 'Remote capability provider denied access.',
			expectedRetryable: undefined,
			failureClass: 'authorization',
		},
		{
			expectedCode: 'validation_failed',
			expectedMessage: 'Remote capability provider rejected the request.',
			expectedRetryable: undefined,
			failureClass: 'invalid_request',
		},
		{
			expectedCode: 'provider_unavailable',
			expectedMessage: 'Remote capability provider is rate limited.',
			expectedRetryable: true,
			failureClass: 'rate_limit',
		},
		{
			expectedCode: 'provider_unavailable',
			expectedMessage: 'Remote capability provider failed.',
			expectedRetryable: true,
			failureClass: 'provider_error',
		},
		{
			expectedCode: 'execution_failed',
			expectedMessage:
				'Remote capability reported an execution error: Input validation failed at $.search_recency: expected day, week, or month.',
			expectedRetryable: undefined,
			failureClass: 'tool_error',
		},
	] as const)(
		'maps remote MCP $failureClass failures to a safe model-facing error',
		async ({ expectedCode, expectedMessage, expectedRetryable, failureClass }) => {
			// Arrange
			const callUpstreamTool = vi.fn(async () => {
				throw createUpstreamMcpError({
					causeMessage: 'provider response detail must not escape',
					elapsedMs: 12,
					failureClass,
					namespace: 'github',
					operation: 'MCP callTool github.get_issue',
					phase: 'call_tool',
					...(failureClass === 'tool_error'
						? {
								providerErrorMessage:
									'Input validation failed at $.search_recency: expected day, week, or month.',
							}
						: {}),
					toolName: 'get_issue',
					transport: { kind: 'streamable-http', url: 'https://provider.example.test/mcp' },
				});
			});
			const backend = createBackendFixture({ callUpstreamTool });

			// Act
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

			// Assert
			const parsedResult = PortalCallResultSchema.parse(result);
			const firstItem = parsedResult.items[0];
			expect(firstItem).toMatchObject({
				error: {
					code: expectedCode,
					message: expect.stringContaining(expectedMessage),
				},
				status: 'error',
			});
			if (firstItem?.status !== 'error') throw new Error('Expected an error item.');
			expect(firstItem.error.retryable).toBe(expectedRetryable);
			expect(JSON.stringify(parsedResult)).not.toContain('provider response detail');
		},
	);

	it('maps upstream input validation failures to schema errors on the capability surface', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = createBackendFixture({ callUpstreamTool });

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
						message: expect.stringMatching(/number.*expected number/u),
					},
					id: 'read-issue',
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
		expect(JSON.stringify(result)).toContain('validation_failed');
		expect(JSON.stringify(result)).not.toContain('Capability execution failed');
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});

	it('maps degraded MCP namespaces to provider unavailable on the capability surface', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = createBackendFixture({
			callUpstreamTool,
			listTools: async () => {
				throw new Error('github unavailable');
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
						code: 'provider_unavailable',
						message: 'Capability provider is unavailable.',
					},
					id: 'read-issue',
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
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});

	it('requires approval for projected write calls and rejects model-supplied tokens', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = createBackendFixture({ callUpstreamTool });

		const result = await backend.call({
			calls: [
				{
					arguments: { title: 'Write' },
					id: 'create-issue',
					namespace: 'github',
					name: 'create_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'approval_required',
					},
					id: 'create-issue',
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
		expect(callUpstreamTool).not.toHaveBeenCalled();

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
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
});
