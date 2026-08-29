import type { ResolvedMcpPortalProfile } from '@agent-vm/config-contracts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { hashCallArguments } from '../portal-auth/hmac-token.js';
import { UpstreamMcpError } from '../upstream-mcp-errors.js';
import { createPortalPolicyApprovalEvaluator } from './portal-approval-evaluator.js';
import {
	createPortalCore,
	collectPortalCoreResult,
	listPortalCoreToolDescriptors,
	type PortalCoreEvent,
} from './portal-core.js';
import type { PortalApprovalCallDecision, PortalApprovalEvaluation } from './portal-tools.js';

const batchTools = [
	{
		description: 'Create issue',
		inputSchema: {
			properties: { title: { type: 'string' } },
			required: ['title'],
			type: 'object',
		},
		name: 'create_issue',
	},
	{
		description: 'Explode',
		inputSchema: { properties: {}, type: 'object' },
		name: 'explode',
	},
] satisfies readonly Tool[];

const scalarTools = [
	{
		inputSchema: { properties: {}, type: 'object' },
		name: 'search_docs',
	},
] satisfies readonly Tool[];

const approvalProfile: ResolvedMcpPortalProfile = {
	approval: {
		allowWithoutApprovalTools: [{ namespace: 'linear', toolName: 'list_issues' }],
		alwaysAskTools: [{ namespace: 'linear', toolName: 'create_issue' }],
		annotationPolicy: 'destructive-requires-approval',
		callPoliciesByNamespace: {},
		trustedAnnotationNamespaces: [],
		writeTools: [],
	},
	cache: { catalogTtlMs: 60_000 },
	enabledNamespaces: ['linear'],
	enabledToolsByNamespace: {},
	hiddenToolsByNamespace: {},
	logging: { enabled: false },
	promptContext: { enabled: true, maxNamespaces: 12 },
};

function allowApproval(calls: readonly { readonly id: string }[]): {
	readonly decisionsByCallId: Readonly<Record<string, { readonly kind: 'allow' }>>;
} {
	return {
		decisionsByCallId: Object.fromEntries(calls.map((call) => [call.id, { kind: 'allow' }])),
	};
}

describe('portal core event stream', () => {
	it('creates trusted agent scopes with adapter source and Hermes session fields', async () => {
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => scalarTools),
			},
			upstreamNamespaces: ['docs'],
		});

		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			sessionId: 'session-id-a',
			sessionKey: 'session-key-a',
			source: 'managed-gateway-trusted',
		});

		expect(scope).toMatchObject({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			sessionId: 'session-id-a',
			sessionKey: 'session-key-a',
			source: 'managed-gateway-trusted',
		});

		await core.close();
	});

	it('describes portal tools with the caller scoped namespace context', async () => {
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'deny-all',
				enabledNamespacesByAgent: {
					'agent-a': ['linear'],
					'agent-b': ['docs'],
				},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => scalarTools),
			},
			upstreamNamespaces: ['docs', 'linear'],
		});
		const agentAScope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const agentBScope = core.createAgentScope({
			agentId: 'agent-b',
			agentScopeId: 'agent-scope-b',
			source: 'cli-operator',
		});

		const agentADescription = core
			.describeTools(agentAScope)
			.find((descriptor) => descriptor.name === 'mcp_portal_list')?.description;
		const agentBDescription = core
			.describeTools(agentBScope)
			.find((descriptor) => descriptor.name === 'mcp_portal_list')?.description;

		expect(agentADescription).toContain('linear');
		expect(agentADescription).not.toContain('docs');
		expect(agentBDescription).toContain('docs');
		expect(agentBDescription).not.toContain('linear');

		await core.close();
	});

	it('puts allowed namespace guidance on the list descriptor and list schema only', () => {
		const descriptors = listPortalCoreToolDescriptors(['deepwiki', 'tavily', 'perplexity']);
		const listDescriptor = descriptors.find((descriptor) => descriptor.name === 'mcp_portal_list');
		const searchDescriptor = descriptors.find(
			(descriptor) => descriptor.name === 'mcp_portal_search',
		);
		const requestSchema = listDescriptor?.inputSchema.properties?.requests;
		const requestItems =
			typeof requestSchema === 'object' && requestSchema !== null && 'items' in requestSchema
				? requestSchema.items
				: undefined;
		const requestProperties =
			typeof requestItems === 'object' && requestItems !== null && 'properties' in requestItems
				? requestItems.properties
				: undefined;
		const namespacesSchema =
			typeof requestProperties === 'object' &&
			requestProperties !== null &&
			'namespaces' in requestProperties
				? requestProperties.namespaces
				: undefined;
		const namespaceDescription =
			typeof namespacesSchema === 'object' &&
			namespacesSchema !== null &&
			'description' in namespacesSchema
				? namespacesSchema.description
				: undefined;

		expect(listDescriptor?.description).toContain(
			'Allowed namespaces for this agent: deepwiki, tavily, perplexity',
		);
		expect(searchDescriptor?.description).not.toContain('Allowed namespaces for this agent:');
		expect(namespaceDescription).toContain(
			'Allowed namespaces for this agent: deepwiki, tavily, perplexity',
		);
	});

	it('carries structured discovery diagnostics into core audit events', async () => {
		const core = createPortalCore({
			accessPolicy: {
				enabledNamespaces: ['tavily'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				closeSession: vi.fn(),
				listTools: vi.fn(async () => {
					throw new UpstreamMcpError({
						causeMessage: 'Authentication failed',
						elapsedMs: 31,
						hint: 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.',
						kind: 'upstream_mcp_failed',
						namespace: 'tavily',
						operation: 'MCP streamable-http connect for namespace "tavily"',
						phase: 'connect',
						timeoutMs: 30_000,
						transport: { kind: 'streamable-http', url: 'https://mcp.tavily.com/mcp/' },
					});
				}),
			},
			upstreamNamespaces: ['tavily'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-a',
			source: 'cli-operator',
		});

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: { requests: [{ id: 'list' }] },
				scope,
				toolName: 'mcp_portal_list',
			}),
		);

		expect(result.auditEvents).toEqual([
			expect.objectContaining({
				causeMessage: 'Upstream MCP provider failed.',
				hint: expect.stringContaining('verify URL'),
				kind: 'upstream_mcp_failed',
				namespace: 'tavily',
				phase: 'connect',
				transport: { kind: 'streamable-http' },
			}),
		]);
		await core.close();
	});

	it('streams batch item progress and collects success and failure results', async () => {
		const callUpstreamTool = vi.fn(async (call: { readonly toolName: string }) => {
			if (call.toolName === 'explode') {
				throw new UpstreamMcpError({
					causeMessage: '502 Bad Gateway',
					elapsedMs: 23,
					hint: 'MCP provider accepted discovery but the tool call failed; inspect the tool arguments and upstream provider response.',
					kind: 'upstream_mcp_failed',
					namespace: 'linear',
					operation: 'tools/call',
					phase: 'call_tool',
					toolName: 'explode',
					transport: {
						kind: 'streamable-http',
						url: 'https://linear.example.test/mcp',
					},
				});
			}
			return { content: [{ text: 'created', type: 'text' }] };
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const observedEvents: PortalCoreEvent[] = [];

		const result = await collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'ok-call',
							namespace: 'linear',
							toolName: 'create_issue',
						},
						{
							arguments: {},
							id: 'bad-call',
							namespace: 'linear',
							toolName: 'explode',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
			{
				onEvent: (event) => {
					observedEvents.push(event);
				},
			},
		);

		expect(observedEvents.map((event) => event.kind)).toEqual([
			'started',
			'item_started',
			'progress',
			'item_started',
			'progress',
			'item_completed',
			'item_failed',
			'completed',
		]);
		expect(observedEvents).toContainEqual(
			expect.objectContaining({
				kind: 'progress',
				requestId: 'ok-call',
			}),
		);
		expect(result).toMatchObject({
			content: [],
			items: [
				{
					requestId: 'ok-call',
					status: 'success',
				},
				{
					error: {
						code: 'upstream_call_failed',
						message: 'linear: call_tool explode failed',
						namespace: 'linear',
						toolName: 'explode',
						upstream: {
							causeMessage: 'Upstream MCP provider failed.',
							hint: expect.stringContaining('provider accepted discovery'),
							kind: 'upstream_mcp_failed',
							namespace: 'linear',
							phase: 'call_tool',
							toolName: 'explode',
							transport: {
								kind: 'streamable-http',
							},
						},
					},
					requestId: 'bad-call',
					status: 'failed',
				},
			],
		});
		expect(callUpstreamTool).toHaveBeenCalledTimes(2);

		await core.close();
	});

	it('surfaces input validation issues in failed core item errors', async () => {
		const callUpstreamTool = vi.fn(async () => ({ content: [{ text: 'created', type: 'text' }] }));
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});

		const result = await collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: {},
							id: 'bad-call',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
		);

		expect(result.items).toEqual([
			{
				error: {
					code: 'input_validation',
					issueCount: 1,
					issues: [
						expect.objectContaining({
							code: expect.any(String),
							expected: 'string',
							message: expect.any(String),
							path: ['title'],
							received: { type: 'undefined' },
						}),
					],
					message: expect.stringContaining('title: expected string; received undefined'),
					namespace: 'linear',
					toolName: 'create_issue',
				},
				requestId: 'bad-call',
				status: 'failed',
			},
		]);
		expect(result.items[0]?.status === 'failed' ? result.items[0].error.message : '').not.toBe(
			'[object Object]',
		);
		expect(callUpstreamTool).not.toHaveBeenCalled();

		await core.close();
	});

	it('caps agent-facing validation issues while reporting truncation', async () => {
		const manyRequiredFieldsTool = {
			inputSchema: {
				properties: {
					alpha: { type: 'string' },
					bravo: { type: 'string' },
					charlie: { type: 'string' },
					delta: { type: 'string' },
					echo: { type: 'string' },
					foxtrot: { type: 'string' },
				},
				required: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'],
				type: 'object',
			},
			name: 'many_required_fields',
		} satisfies Tool;
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => [manyRequiredFieldsTool]),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});

		const result = await collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: {},
							id: 'bad-call',
							namespace: 'linear',
							toolName: 'many_required_fields',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
		);

		expect(result.items).toEqual([
			{
				error: expect.objectContaining({
					code: 'input_validation',
					issueCount: 6,
					issues: expect.arrayContaining([
						expect.objectContaining({ path: ['alpha'] }),
						expect.objectContaining({ path: ['echo'] }),
					]),
					issuesTruncated: 1,
					message: expect.stringContaining('1 more validation issue(s) omitted'),
				}),
				requestId: 'bad-call',
				status: 'failed',
			},
		]);
		if (result.items[0]?.status !== 'failed') {
			throw new Error('expected failed item');
		}
		expect(result.items[0].error.issues).toHaveLength(5);
		expect(result.items[0].error.message).not.toContain('foxtrot');

		await core.close();
	});

	it('forwards real upstream progress events while the call is in flight', async () => {
		const callUpstreamTool = vi.fn(async (call) => {
			call.onEvent?.({
				kind: 'progress',
				message: 'upstream half done',
				progress: 5,
				total: 10,
			});
			return { content: [{ text: 'created', type: 'text' }] };
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const observedEvents: PortalCoreEvent[] = [];

		await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'ok-call',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
			{
				onEvent: (event) => {
					observedEvents.push(event);
				},
			},
		);

		expect(observedEvents).toContainEqual({
			kind: 'progress',
			message: 'upstream half done',
			progress: 5,
			requestId: 'ok-call',
			total: 10,
		});

		await core.close();
	});

	it('forwards typed upstream notification and partial-content events from the runtime', async () => {
		const callUpstreamTool = vi.fn(async (call) => {
			call.onEvent?.({
				kind: 'upstream_notification',
				method: 'notifications/message',
				params: { data: 'halfway', level: 'info' },
			});
			call.onEvent?.({
				content: { text: 'partial output chunk', type: 'text' },
				kind: 'partial_content',
			});
			return { content: [{ text: 'final output', type: 'text' }] };
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const observedEvents: PortalCoreEvent[] = [];

		await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'ok-call',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
			{
				onEvent: (event) => {
					observedEvents.push(event);
				},
			},
		);

		expect(observedEvents).toContainEqual({
			kind: 'upstream_notification',
			method: 'notifications/message',
			params: { data: 'halfway', level: 'info' },
			requestId: 'ok-call',
		});
		expect(observedEvents).toContainEqual({
			content: { text: 'partial output chunk', type: 'text' },
			kind: 'partial_content',
			requestId: 'ok-call',
		});

		await core.close();
	});

	it('evaluates approval once and applies decisions per call before upstream contact', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const approval = vi.fn(
			(calls: readonly { readonly id: string }[]): PortalApprovalEvaluation => {
				const decisionsByCallId: Record<string, PortalApprovalCallDecision> = {};
				for (const call of calls) {
					decisionsByCallId[call.id] = { kind: 'approval_required', level: 'standard' };
				}
				return {
					decisionsByCallId,
				};
			},
		);
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const observedEvents: PortalCoreEvent[] = [];

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: { title: 'Read first' },
							id: 'read-call',
							namespace: 'linear',
							toolName: 'create_issue',
						},
						{
							arguments: {},
							id: 'write-call',
							namespace: 'linear',
							toolName: 'explode',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
			{
				onEvent: (event) => {
					observedEvents.push(event);
				},
			},
		);

		expect(approval).toHaveBeenCalledTimes(1);
		const approvalCalls = approval.mock.calls[0]?.[0];
		expect(approvalCalls?.map((call) => call.id)).toEqual(['read-call', 'write-call']);
		expect(callUpstreamTool).not.toHaveBeenCalled();
		expect(observedEvents.map((event) => event.kind)).toEqual([
			'started',
			'item_failed',
			'item_failed',
			'completed',
		]);
		expect(result.items).toEqual([
			expect.objectContaining({
				error: expect.objectContaining({ code: 'approval_required' }),
				requestId: 'read-call',
				status: 'failed',
			}),
			expect.objectContaining({
				error: expect.objectContaining({ code: 'approval_required' }),
				requestId: 'write-call',
				status: 'failed',
			}),
		]);

		await core.close();
	});

	it('returns approval-required only for gated native calls when no portal token is present', async () => {
		const approval = createPortalPolicyApprovalEvaluator({
			missingApprovalTokenDecision: { kind: 'approval_required', level: 'standard' },
			resolveRecord: () => ({ hmacKey: Buffer.alloc(32, 1), profile: approvalProfile }),
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(async () => ({ ok: true })),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(
					async () =>
						[
							{
								inputSchema: { properties: {}, type: 'object' },
								name: 'list_issues',
							},
							{
								inputSchema: {
									properties: { title: { type: 'string' } },
									required: ['title'],
									type: 'object',
								},
								name: 'create_issue',
							},
						] satisfies readonly Tool[],
				),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'managed-gateway-trusted',
		});

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{ arguments: {}, id: 'list', namespace: 'linear', toolName: 'list_issues' },
						{
							arguments: { title: 'Fix deploy' },
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
		);

		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requestId: 'list', status: 'success' }),
				expect.objectContaining({
					error: expect.objectContaining({ code: 'approval_required' }),
					requestId: 'create',
					status: 'failed',
				}),
			]),
		);

		await core.close();
	});

	it('prepares approval token digests from validated arguments', async () => {
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(async () => ({ ok: true })),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(
					async () =>
						[
							{
								inputSchema: {
									properties: { title: { default: 'Fallback title', type: 'string' } },
									type: 'object',
								},
								name: 'create_issue_with_default',
							},
						] satisfies readonly Tool[],
				),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'managed-gateway-trusted',
		});

		await expect(
			core.approval.prepareCallDigests({
				input: {
					calls: [
						{
							arguments: {},
							id: 'defaulted',
							namespace: 'linear',
							toolName: 'create_issue_with_default',
						},
					],
				},
				scope,
			}),
		).resolves.toEqual({
			defaulted: {
				argumentsHash: hashCallArguments({ title: 'Fallback title' }),
				namespace: 'linear',
				toolName: 'create_issue_with_default',
			},
		});

		await core.close();
	});

	it('denies calls for tools outside the agent enabled tool list before upstream contact', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'deny-all',
				enabledNamespaces: ['linear'],
				enabledNamespacesByAgent: {},
				enabledToolsByNamespaceByAgent: {
					'agent-a': { linear: ['create_issue'] },
				},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: {},
							id: 'blocked-call',
							namespace: 'linear',
							toolName: 'explode',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
		);

		expect(callUpstreamTool).not.toHaveBeenCalled();
		expect(result.items).toEqual([
			expect.objectContaining({
				error: expect.objectContaining({
					code: 'unknown_or_denied_tool',
					namespace: 'linear',
					toolName: 'explode',
				}),
				requestId: 'blocked-call',
				status: 'failed',
			}),
		]);

		await core.close();
	});

	it('rejects duplicate batch request ids before upstream contact', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const observedEvents: PortalCoreEvent[] = [];

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: { title: 'First' },
							id: 'duplicate-call',
							namespace: 'linear',
							toolName: 'create_issue',
						},
						{
							arguments: { title: 'Second' },
							id: 'duplicate-call',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
			{
				onEvent: (event) => {
					observedEvents.push(event);
				},
			},
		);

		expect(callUpstreamTool).not.toHaveBeenCalled();
		expect(observedEvents.map((event) => event.kind)).toEqual(['started', 'completed']);
		expect(JSON.stringify(result.structuredContent)).toContain('duplicate');

		await core.close();
	});

	it('fails a pre-aborted stream before upstream contact', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const controller = new AbortController();
		controller.abort(new Error('cancelled by test'));
		const observedEvents: PortalCoreEvent[] = [];

		await expect(
			core.collectPortalCoreResult(
				core.callStream({
					input: {
						calls: [
							{
								arguments: { title: 'First' },
								id: 'call-1',
								namespace: 'linear',
								toolName: 'create_issue',
							},
						],
					},
					scope,
					signal: controller.signal,
					toolName: 'mcp_portal_call',
				}),
				{
					onEvent: (event) => {
						observedEvents.push(event);
					},
				},
			),
		).rejects.toThrow(/cancelled by test/u);
		expect(observedEvents.map((event) => event.kind)).toEqual(['failed']);
		expect(callUpstreamTool).not.toHaveBeenCalled();

		await core.close();
	});

	it('wakes and fails a batch stream aborted while upstream is silent', async () => {
		const callUpstreamTool = vi.fn(() => new Promise<never>(() => undefined));
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const controller = new AbortController();
		const stream = core.callStream({
			input: {
				calls: [
					{
						arguments: { title: 'First' },
						id: 'call-1',
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
			},
			scope,
			signal: controller.signal,
			toolName: 'mcp_portal_call',
		});
		const iterator = stream[Symbol.asyncIterator]();

		const started = await iterator.next();
		const itemStarted = await iterator.next();
		const progress = await iterator.next();
		controller.abort(new Error('cancelled while upstream is silent'));
		const failed = await iterator.next();

		expect(callUpstreamTool).toHaveBeenCalledTimes(1);
		expect(started.value).toMatchObject({ kind: 'started' });
		expect(itemStarted.value).toMatchObject({ kind: 'item_started', requestId: 'call-1' });
		expect(progress.value).toMatchObject({ kind: 'progress', requestId: 'call-1' });
		expect(failed.value).toMatchObject({
			error: expect.any(Error),
			kind: 'failed',
		});

		await core.close();
	});

	it('drains queued upstream events before reporting a later abort', async () => {
		const controller = new AbortController();
		const callUpstreamTool = vi.fn((call) => {
			call.onEvent?.({
				kind: 'progress',
				message: 'queued before abort',
				progress: 1,
				total: 2,
			});
			controller.abort(new Error('cancelled after upstream queued progress'));
			return new Promise<never>(() => undefined);
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const stream = core.callStream({
			input: {
				calls: [
					{
						arguments: { title: 'First' },
						id: 'call-1',
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
			},
			scope,
			signal: controller.signal,
			toolName: 'mcp_portal_call',
		});
		const iterator = stream[Symbol.asyncIterator]();

		const started = await iterator.next();
		const itemStarted = await iterator.next();
		const syntheticProgress = await iterator.next();
		const upstreamProgress = await iterator.next();
		const failed = await iterator.next();

		expect(started.value).toMatchObject({ kind: 'started' });
		expect(itemStarted.value).toMatchObject({ kind: 'item_started', requestId: 'call-1' });
		expect(syntheticProgress.value).toMatchObject({ kind: 'progress', requestId: 'call-1' });
		expect(upstreamProgress.value).toMatchObject({
			kind: 'progress',
			message: 'queued before abort',
			requestId: 'call-1',
		});
		expect(failed.value).toMatchObject({
			error: expect.any(Error),
			kind: 'failed',
		});

		await core.close();
	});

	it('fails instead of growing an unbounded upstream event queue', async () => {
		const callUpstreamTool = vi.fn(async (call) => {
			for (let index = 0; index < 1_025; index += 1) {
				call.onEvent?.({
					kind: 'progress',
					message: `flood ${index}`,
					progress: index,
				});
			}
			return { ok: true };
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: { title: 'Flood' },
							id: 'call-1',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
		);

		expect(result.items).toEqual([
			expect.objectContaining({
				error: expect.objectContaining({
					code: 'upstream_call_failed',
					message: expect.stringMatching(/event queue exceeded/u),
				}),
				requestId: 'call-1',
				status: 'failed',
			}),
		]);

		await core.close();
	});

	it('fails instead of queuing oversized upstream event payloads', async () => {
		const callUpstreamTool = vi.fn(async (call) => {
			call.onEvent?.({
				content: [{ text: 'x'.repeat(300 * 1_024), type: 'text' }],
				kind: 'partial_content',
			});
			return { ok: true };
		});
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool,
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => batchTools),
			},
			upstreamNamespaces: ['linear'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: {
					calls: [
						{
							arguments: { title: 'Oversized' },
							id: 'call-1',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				scope,
				toolName: 'mcp_portal_call',
			}),
		);

		expect(result.items).toEqual([
			expect.objectContaining({
				error: expect.objectContaining({
					code: 'upstream_call_failed',
					message: expect.stringMatching(/core event exceeded/u),
				}),
				requestId: 'call-1',
				status: 'failed',
			}),
		]);

		await core.close();
	});

	it('emits a failed terminal event when scalar execution is aborted after start', async () => {
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => {
					throw new Error('catalog failed');
				}),
			},
			upstreamNamespaces: ['docs'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const controller = new AbortController();
		const observedEvents: PortalCoreEvent[] = [];

		for await (const event of core.callStream({
			input: { requests: [{ id: 'list-docs', limit: 10 }] },
			scope,
			signal: controller.signal,
			toolName: 'mcp_portal_list',
		})) {
			observedEvents.push(event);
			controller.abort(new Error('cancelled after stream start'));
		}

		expect(observedEvents.map((event) => event.kind)).toEqual(['started', 'failed']);
		expect(observedEvents.at(-1)).toMatchObject({
			error: expect.any(Error),
			kind: 'failed',
		});

		await core.close();
	});

	it('wakes and fails a scalar stream aborted while catalog work is pending', async () => {
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(() => new Promise<never>(() => undefined)),
			},
			upstreamNamespaces: ['docs'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const controller = new AbortController();
		const stream = core.callStream({
			input: { requests: [{ id: 'list-docs', limit: 10 }] },
			scope,
			signal: controller.signal,
			toolName: 'mcp_portal_list',
		});
		const iterator = stream[Symbol.asyncIterator]();

		const started = await iterator.next();
		controller.abort(new Error('cancelled scalar while pending'));
		const failed = await iterator.next();

		expect(started.value).toMatchObject({ kind: 'started' });
		expect(failed.value).toMatchObject({
			error: expect.any(Error),
			kind: 'failed',
		});

		await core.close();
	});

	it('collects scalar tool output without item events', async () => {
		const core = createPortalCore({
			accessPolicy: {
				defaultPolicy: 'allow-all',
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: allowApproval,
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				listTools: vi.fn(async () => scalarTools),
			},
			upstreamNamespaces: ['docs'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			source: 'cli-operator',
		});
		const observedEvents: PortalCoreEvent[] = [];

		const result = await core.collectPortalCoreResult(
			core.callStream({
				input: { requests: [{ id: 'list-docs', limit: 10 }] },
				scope,
				toolName: 'mcp_portal_list',
			}),
			{
				onEvent: (event) => {
					observedEvents.push(event);
				},
			},
		);

		expect(observedEvents.map((event) => event.kind)).toEqual(['started', 'completed']);
		expect(result.items).toEqual([]);
		expect(result.content).toEqual([
			expect.objectContaining({
				type: 'json',
				value: expect.objectContaining({ ok: true }),
			}),
		]);

		await core.close();
	});
});
