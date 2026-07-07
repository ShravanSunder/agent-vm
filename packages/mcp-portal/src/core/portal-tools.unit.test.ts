import { describe, expect, it, vi } from 'vitest';

import {
	createPortalAgentIdentity as createPortalAgentIdentityBase,
	type PortalAgentIdentity,
} from '../portal-access-policy.js';
import type { PortalSession } from '../portal-session.js';
import { UpstreamMcpError } from '../upstream-mcp-errors.js';
import { createPortalToolHandlers } from './portal-tools.js';

function createPortalAgentIdentity(
	input: Omit<Parameters<typeof createPortalAgentIdentityBase>[0], 'source'>,
): PortalAgentIdentity {
	return createPortalAgentIdentityBase({ ...input, source: 'cli-operator' });
}

const session = {
	catalog: {
		agentScopeId: 'agent-scope-a',
		discoveryFailures: [],
		generatedAt: '2026-05-10T00:00:00.000Z',
		sourceHash: 'hash',
		tools: [
			{
				description: 'Create an issue',
				inputSchema: {
					properties: { title: { type: 'string' } },
					required: ['title'],
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'create_issue',
			},
			{
				description: 'Create an issue with defaults',
				inputSchema: {
					properties: { title: { default: 'Fallback title', type: 'string' } },
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'create_issue_with_default',
			},
			{
				description: 'List teams',
				inputSchema: {
					additionalProperties: false,
					properties: {
						includeArchived: { type: 'boolean' },
						limit: { type: 'number' },
					},
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'list_teams',
			},
		],
	},
	graph: { relationships: [], skills: [] },
	identity: createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-scope-a' }),
	searchIndex: {
		search: () => ({
			results: [
				{
					input: { optional: [], propertyCount: 1, required: ['title'], type: 'object' },
					namespace: 'linear',
					safety: {},
					toolName: 'create_issue',
					toolRef: 'mcp:bGluZWFy:Y3JlYXRlX2lzc3Vl',
				},
			],
		}),
	},
} satisfies PortalSession;

const degradedSession = {
	...session,
	catalog: {
		...session.catalog,
		discoveryFailures: [
			{
				kind: 'upstream_discovery_failed',
				message: 'readwise unavailable',
				namespace: 'readwise',
			},
		],
	},
} satisfies PortalSession;

const transportFailureSession = {
	...session,
	catalog: {
		...session.catalog,
		discoveryFailures: [
			{
				causeMessage: 'spawn failed',
				elapsedMs: 12,
				kind: 'upstream_mcp_failed',
				message: 'local-tools: connect failed: spawn failed',
				namespace: 'local-tools',
				operation: 'initialize',
				phase: 'connect',
				transport: {
					argCount: 2,
					command: '/secret/bin/mcp-provider',
					cwd: '/secret/workdir',
					kind: 'stdio',
				},
			},
		],
	},
} satisfies PortalSession;

function allowDecision(calls: readonly { readonly id: string }[]): {
	readonly decisionsByCallId: Readonly<Record<string, { readonly kind: 'allow' }>>;
} {
	return {
		decisionsByCallId: Object.fromEntries(calls.map((call) => [call.id, { kind: 'allow' }])),
	};
}

describe('portal tool handlers', () => {
	it('lists compact summaries as keyed discriminated results', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});

		const listResult = await handlers.list({
			identity: session.identity,
			input: { requests: [{ id: 'linear-tools', limit: 10 }] },
		});

		expect(listResult).toMatchObject({
			diagnostics: [],
			errors: [],
			ok: true,
			results: {
				'linear-tools': {
					input: { id: 'linear-tools', limit: 10 },
					ok: true,
					output: {
						namespaces: ['linear'],
						tools: expect.arrayContaining([
							expect.not.objectContaining({ inputSchema: expect.anything() }),
						]),
					},
				},
			},
		});
	});

	it('surfaces degraded discovery diagnostics on every portal tool response', async () => {
		const handlers = createPortalToolHandlers({
			approval: allowDecision,
			callUpstreamTool: vi.fn(async () => ({ content: [] })),
			getSession: vi.fn(async () => degradedSession),
		});
		const expectedDiagnostics = [
			{
				kind: 'upstream_discovery_failed',
				message: 'readwise unavailable',
				namespace: 'readwise',
			},
		];

		await expect(
			handlers.list({
				identity: session.identity,
				input: { requests: [{ id: 'list-linear', limit: 10 }] },
			}),
		).resolves.toMatchObject({ diagnostics: expectedDiagnostics, ok: true });
		await expect(
			handlers.search({
				identity: session.identity,
				input: { requests: [{ id: 'search-linear', query: 'issue' }] },
			}),
		).resolves.toMatchObject({ diagnostics: expectedDiagnostics, ok: true });
		await expect(
			handlers.describe({
				identity: session.identity,
				input: {
					requests: [
						{
							id: 'describe-linear',
							tools: [{ namespace: 'linear', toolName: 'create_issue' }],
						},
					],
				},
			}),
		).resolves.toMatchObject({ diagnostics: expectedDiagnostics, ok: true });
		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'call-linear',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
			}),
		).resolves.toMatchObject({ diagnostics: expectedDiagnostics, ok: true });
	});

	it('redacts transport details from list discovery diagnostics', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => transportFailureSession),
		});

		const listResult = await handlers.list({
			identity: transportFailureSession.identity,
			input: { requests: [{ id: 'linear-tools', limit: 10 }] },
		});

		expect(listResult.diagnostics).toMatchObject([
			{
				kind: 'upstream_mcp_failed',
				namespace: 'local-tools',
				transport: { kind: 'stdio' },
			},
		]);
		const serializedResult = JSON.stringify(listResult);
		expect(serializedResult).not.toContain('/secret/bin/mcp-provider');
		expect(serializedResult).not.toContain('/secret/workdir');
		expect(serializedResult).not.toContain('argCount');
	});

	it('fails closed with a disabled namespace error when a degraded namespace is called', async () => {
		const callUpstreamTool = vi.fn(async () => ({ content: [] }));
		const handlers = createPortalToolHandlers({
			approval: allowDecision,
			callUpstreamTool,
			getSession: vi.fn(async () => degradedSession),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { query: 'deployment' },
							id: 'call-readwise',
							namespace: 'readwise',
							toolName: 'search_highlights',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			diagnostics: [
				{
					kind: 'upstream_discovery_failed',
					message: 'readwise unavailable',
					namespace: 'readwise',
				},
			],
			ok: false,
			results: {
				'call-readwise': {
					error: {
						kind: 'namespace_unavailable',
						message: 'MCP namespace "readwise" is disabled/unavailable: readwise unavailable',
						namespace: 'readwise',
						toolName: 'search_highlights',
					},
					ok: false,
				},
			},
		});
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});

	it('returns structured discovery diagnostics in portal tool responses', async () => {
		const structuredDegradedSession = {
			...session,
			catalog: {
				...session.catalog,
				discoveryFailures: [
					{
						causeMessage: 'Authentication failed',
						elapsedMs: 44,
						hint: 'remote MCP connection failed; verify URL, auth header, network egress, and transport kind.',
						kind: 'upstream_mcp_failed',
						message: 'tavily: connect failed: Authentication failed',
						namespace: 'tavily',
						operation: 'MCP streamable-http connect for namespace "tavily"',
						phase: 'connect',
						timeoutMs: 30_000,
						transport: { kind: 'streamable-http', url: 'https://mcp.tavily.com/mcp/' },
					},
				],
			},
		} satisfies PortalSession;
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => structuredDegradedSession),
		});

		const listResult = await handlers.list({
			identity: session.identity,
			input: { requests: [{ id: 'list-tools' }] },
		});

		expect(listResult).toMatchObject({
			diagnostics: [
				{
					causeMessage: 'Authentication failed',
					hint: expect.stringContaining('verify URL'),
					kind: 'upstream_mcp_failed',
					namespace: 'tavily',
					phase: 'connect',
					transport: { kind: 'streamable-http' },
				},
			],
			ok: true,
		});
		expect(JSON.stringify(listResult)).not.toContain('https://mcp.tavily.com/mcp/');
	});

	it('rejects model-supplied identity fields and duplicate ids at the envelope level', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.list({
				identity: session.identity,
				input: { agentId: 'spoof', requests: [{ id: 'linear-tools', limit: 10 }] },
			}),
		).resolves.toMatchObject({
			errors: [expect.objectContaining({ kind: 'invalid_portal_input' })],
			ok: false,
			results: {},
		});

		await expect(
			handlers.search({
				identity: session.identity,
				input: { requests: [{ id: 'same' }, { id: 'same', query: 'issue' }] },
			}),
		).resolves.toMatchObject({
			errors: [expect.objectContaining({ id: 'same', kind: 'duplicate_id' })],
			ok: false,
			results: {},
		});
	});

	it('rejects malformed list cursors instead of coercing them', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.list({
				identity: session.identity,
				input: { requests: [{ cursor: '12abc', id: 'linear-tools', limit: 10 }] },
			}),
		).resolves.toMatchObject({
			errors: [expect.objectContaining({ kind: 'invalid_portal_input' })],
			ok: false,
			results: {},
		});
	});

	it('rejects reserved request ids for every portal tool', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});
		const expectedFailure = {
			errors: [expect.objectContaining({ kind: 'invalid_portal_input' })],
			ok: false,
			results: {},
		};

		await expect(
			handlers.list({
				identity: session.identity,
				input: { requests: [{ id: '__proto__', limit: 10 }] },
			}),
		).resolves.toMatchObject(expectedFailure);
		await expect(
			handlers.search({
				identity: session.identity,
				input: { requests: [{ id: 'constructor', query: 'issue' }] },
			}),
		).resolves.toMatchObject(expectedFailure);
		await expect(
			handlers.describe({
				identity: session.identity,
				input: {
					requests: [
						{
							id: 'prototype',
							tools: [{ namespace: 'linear', toolName: 'create_issue' }],
						},
					],
				},
			}),
		).resolves.toMatchObject(expectedFailure);
		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: '__proto__',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
			}),
		).resolves.toMatchObject(expectedFailure);
	});

	it('searches multiple requests and keys each output by request id', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.search({
				identity: session.identity,
				input: {
					requests: [
						{ id: 'write-linear', query: 'create issue' },
						{ id: 'schema-linear', query: 'title', schemaDetail: 'full' },
					],
				},
			}),
		).resolves.toMatchObject({
			ok: true,
			results: {
				'schema-linear': {
					input: { id: 'schema-linear', limit: 10, query: 'title', schemaDetail: 'full' },
					ok: true,
					output: {
						tools: [
							expect.objectContaining({ inputSchema: expect.objectContaining({ type: 'object' }) }),
						],
					},
				},
				'write-linear': {
					input: {
						id: 'write-linear',
						limit: 10,
						query: 'create issue',
						schemaDetail: 'summary',
					},
					ok: true,
					output: { tools: [expect.objectContaining({ toolName: 'create_issue' })] },
				},
			},
		});
	});

	it('adds schema-disclosure hints to list and summary search results', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});
		const expectedHint = {
			message: 'Use mcp_portal_describe for exact input schema before calling.',
			next: 'describe_before_call',
		};

		await expect(
			handlers.list({
				identity: session.identity,
				input: { requests: [{ id: 'linear-tools', limit: 10 }] },
			}),
		).resolves.toMatchObject({
			results: {
				'linear-tools': {
					output: {
						tools: expect.arrayContaining([expect.objectContaining({ schemaHint: expectedHint })]),
					},
				},
			},
		});
		await expect(
			handlers.search({
				identity: session.identity,
				input: { requests: [{ id: 'search-linear', query: 'issue', schemaDetail: 'summary' }] },
			}),
		).resolves.toMatchObject({
			results: {
				'search-linear': {
					output: {
						tools: expect.arrayContaining([expect.objectContaining({ schemaHint: expectedHint })]),
					},
				},
			},
		});
	});

	it('adds call-ready schema hints to describe and full-schema search results', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});
		const expectedHint = {
			message: 'Full input schema included.',
			next: 'call_ready',
		};

		await expect(
			handlers.describe({
				identity: session.identity,
				input: {
					requests: [
						{
							id: 'describe-linear',
							tools: [{ namespace: 'linear', toolName: 'create_issue' }],
						},
					],
				},
			}),
		).resolves.toMatchObject({
			results: {
				'describe-linear': {
					output: {
						tools: expect.arrayContaining([expect.objectContaining({ schemaHint: expectedHint })]),
					},
				},
			},
		});
		await expect(
			handlers.search({
				identity: session.identity,
				input: { requests: [{ id: 'search-linear', query: 'issue', schemaDetail: 'full' }] },
			}),
		).resolves.toMatchObject({
			results: {
				'search-linear': {
					output: {
						tools: expect.arrayContaining([expect.objectContaining({ schemaHint: expectedHint })]),
					},
				},
			},
		});
	});

	it('describes full schemas and optional TypeScript helpers in keyed results', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.describe({
				identity: session.identity,
				input: {
					requests: [
						{
							id: 'linear-create',
							includeTypescriptHelper: true,
							tools: [{ namespace: 'linear', toolName: 'create_issue' }],
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: true,
			results: {
				'linear-create': {
					input: {
						id: 'linear-create',
						includeJsonSchema: true,
						includeRelated: true,
						includeTypescriptHelper: true,
						includeZod: false,
						tools: [{ namespace: 'linear', toolName: 'create_issue' }],
					},
					ok: true,
					output: {
						tools: [
							expect.objectContaining({
								inputSchema: expect.objectContaining({ type: 'object' }),
								typescriptHelper: expect.stringContaining('z.fromJSONSchema'),
							}),
						],
					},
				},
			},
		});
	});

	it('returns per-request structured errors for invalid refs and unknown exact selectors', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.list({
				identity: session.identity,
				input: { requests: [{ id: 'bad-ref', refs: ['not-a-tool-ref'] }] },
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'bad-ref': {
					error: { kind: 'invalid_portal_input' },
					ok: false,
				},
			},
		});

		await expect(
			handlers.describe({
				identity: session.identity,
				input: {
					requests: [
						{
							id: 'missing-tool',
							tools: [{ namespace: 'linear', toolName: 'missing' }],
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'missing-tool': {
					error: {
						kind: 'unknown_or_denied_tool',
						tools: [{ namespace: 'linear', toolName: 'missing' }],
					},
					ok: false,
				},
			},
		});
	});

	it('validates batched call arguments before invoking upstream per item', async () => {
		const callUpstreamTool = vi.fn(async () => ({ content: [{ text: 'created', type: 'text' }] }));
		const handlers = createPortalToolHandlers({
			approval: allowDecision,
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: {},
							id: 'invalid-create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
						{
							arguments: { title: 'Fix deploy' },
							id: 'valid-create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'invalid-create': {
					error: { kind: 'input_validation' },
					ok: false,
				},
				'valid-create': {
					input: {
						arguments: { title: 'Fix deploy' },
						id: 'valid-create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
					ok: true,
					output: {
						namespace: 'linear',
						toolName: 'create_issue',
					},
				},
			},
		});
		expect(callUpstreamTool).toHaveBeenCalledTimes(1);
	});

	it('fails closed for executable calls when approval evaluation is not configured', async () => {
		const callUpstreamTool = vi.fn(async () => ({ content: [{ text: 'created', type: 'text' }] }));
		const handlers = createPortalToolHandlers({
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'valid-create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'valid-create': {
					error: { kind: 'approval_configuration_missing' },
					ok: false,
				},
			},
		});
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});

	it('fails closed when a tool schema cannot be converted for validation', async () => {
		const callUpstreamTool = vi.fn(async () => ({ content: [{ text: 'created', type: 'text' }] }));
		const handlers = createPortalToolHandlers({
			callUpstreamTool,
			getSession: vi.fn(async () => ({
				...session,
				catalog: {
					...session.catalog,
					tools: [
						...session.catalog.tools,
						{
							inputSchema: {
								properties: { title: { type: 'string' } },
								unevaluatedProperties: false,
								type: 'object',
							},
							namespace: 'linear',
							toolName: 'unsupported_schema',
						},
					],
				},
			})),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'unsupported-create',
							namespace: 'linear',
							toolName: 'unsupported_schema',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'unsupported-create': {
					error: {
						feature: 'unevaluatedProperties',
						kind: 'schema_validation_unavailable',
						namespace: 'linear',
						path: ['unevaluatedProperties'],
						toolName: 'unsupported_schema',
					},
					ok: false,
				},
			},
		});
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});

	it('returns upstream failures as keyed item errors without aborting sibling calls', async () => {
		const callUpstreamTool = vi.fn(async (call: { readonly toolName: string }) => {
			if (call.toolName === 'create_issue') {
				throw new UpstreamMcpError({
					causeMessage: '502 Bad Gateway',
					elapsedMs: 47,
					hint: 'MCP provider accepted discovery but the tool call failed; inspect the tool arguments and upstream provider response.',
					kind: 'upstream_mcp_failed',
					namespace: 'linear',
					operation: 'tools/call',
					phase: 'call_tool',
					toolName: 'create_issue',
					transport: {
						kind: 'streamable-http',
						url: 'https://linear.example.test/mcp',
					},
				});
			}
			return { content: [{ text: 'created', type: 'text' }] };
		});
		const handlers = createPortalToolHandlers({
			approval: allowDecision,
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		const callResult = await handlers.call({
			identity: session.identity,
			input: {
				calls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'failed-create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
					{
						arguments: {},
						id: 'defaulted-create',
						namespace: 'linear',
						toolName: 'create_issue_with_default',
					},
				],
			},
		});

		expect(callResult).toMatchObject({
			ok: false,
			results: {
				'defaulted-create': {
					ok: true,
					output: {
						namespace: 'linear',
						toolName: 'create_issue_with_default',
					},
				},
				'failed-create': {
					error: {
						kind: 'upstream_call_failed',
						message: 'linear: call_tool create_issue failed: 502 Bad Gateway',
						namespace: 'linear',
						toolName: 'create_issue',
						upstream: {
							causeMessage: '502 Bad Gateway',
							kind: 'upstream_mcp_failed',
							namespace: 'linear',
							phase: 'call_tool',
							toolName: 'create_issue',
							transport: {
								kind: 'streamable-http',
							},
						},
					},
					input: {
						arguments: { title: 'Fix deploy' },
						id: 'failed-create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
					ok: false,
				},
			},
		});
		expect(JSON.stringify(callResult)).not.toContain('https://linear.example.test/mcp');
		expect(callUpstreamTool).toHaveBeenCalledTimes(2);
	});

	it('passes canonical validated batch arguments to approval and upstream calls', async () => {
		const approval = vi.fn(allowDecision);
		const callUpstreamTool = vi.fn(async () => ({ content: [{ text: 'created', type: 'text' }] }));
		const identity = createPortalAgentIdentity({
			agentId: session.identity.agentId,
			agentScopeId: session.identity.agentScopeId,
			sessionId: 'session-a',
		});
		const handlers = createPortalToolHandlers({
			approval,
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity,
				input: {
					calls: [
						{
							arguments: {},
							id: 'defaulted-create',
							namespace: 'linear',
							toolName: 'create_issue_with_default',
						},
					],
				},
			}),
		).resolves.toMatchObject({ ok: true });

		expect(approval).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					arguments: { title: 'Fallback title' },
					id: 'defaulted-create',
					toolName: 'create_issue_with_default',
				}),
			],
			identity,
			undefined,
		);
		expect(callUpstreamTool).toHaveBeenCalledWith(
			expect.objectContaining({
				arguments: { title: 'Fallback title' },
				agentScopeId: 'agent-scope-a\nsession-a',
			}),
		);
	});

	it('passes schema-normalized scalar arguments to approval and upstream calls', async () => {
		const approval = vi.fn(allowDecision);
		const callUpstreamTool = vi.fn(async () => ({ content: [{ text: 'teams', type: 'text' }] }));
		const handlers = createPortalToolHandlers({
			approval,
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { includeArchived: 'false', limit: '20' },
							id: 'list-teams',
							namespace: 'linear',
							toolName: 'list_teams',
						},
					],
				},
			}),
		).resolves.toMatchObject({ ok: true });

		expect(approval).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					arguments: { includeArchived: false, limit: 20 },
					id: 'list-teams',
					toolName: 'list_teams',
				}),
			],
			session.identity,
			undefined,
		);
		expect(callUpstreamTool).toHaveBeenCalledWith(
			expect.objectContaining({
				arguments: { includeArchived: false, limit: 20 },
				toolName: 'list_teams',
			}),
		);
	});

	it('accepts the unadvertised server-injected approval token for approval bridging', async () => {
		const approval = vi.fn(allowDecision);
		const callUpstreamTool = vi.fn(async () => ({ content: [{ text: 'created', type: 'text' }] }));
		const handlers = createPortalToolHandlers({
			approval,
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					portalApprovalToken: 'server-injected-token',
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'approved-create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
			}),
		).resolves.toMatchObject({ ok: true });

		expect(approval).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'approved-create', toolName: 'create_issue' })],
			session.identity,
			'server-injected-token',
		);
	});

	it('rejects model-visible commit tokens in v1', async () => {
		const handlers = createPortalToolHandlers({
			callUpstreamTool: vi.fn(),
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					commitToken: 'model-supplied-token',
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			errors: [expect.objectContaining({ kind: 'invalid_portal_input' })],
			ok: false,
			results: {},
		});
	});

	it('executes approval-free calls when another prepared call needs approval', async () => {
		const callUpstreamTool = vi.fn(async (call) => ({
			content: [{ text: `called ${call.toolName}`, type: 'text' }],
		}));
		const handlers = createPortalToolHandlers({
			approval: (calls) => ({
				decisionsByCallId: Object.fromEntries(
					calls.map((call) => [
						call.id,
						call.toolName === 'create_issue'
							? { kind: 'approval_required', level: 'critical' }
							: { kind: 'allow' },
					]),
				),
			}),
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'needs-approval',
							namespace: 'linear',
							toolName: 'create_issue',
						},
						{
							arguments: {},
							id: 'safe-defaulted',
							namespace: 'linear',
							toolName: 'create_issue_with_default',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'needs-approval': {
					error: {
						kind: 'approval_required',
						level: 'critical',
						message: 'Operator approval is required before this MCP Portal call can run.',
					},
					ok: false,
				},
				'safe-defaulted': {
					ok: true,
					output: {
						namespace: 'linear',
						toolName: 'create_issue_with_default',
					},
				},
			},
		});

		expect(callUpstreamTool).toHaveBeenCalledTimes(1);
		expect(callUpstreamTool).toHaveBeenCalledWith(
			expect.objectContaining({
				arguments: { title: 'Fallback title' },
				toolName: 'create_issue_with_default',
			}),
		);
	});

	it('returns item-level call-blocked errors while executing allowed siblings', async () => {
		const callUpstreamTool = vi.fn(async (call) => ({
			content: [{ text: `called ${call.toolName}`, type: 'text' }],
		}));
		const handlers = createPortalToolHandlers({
			approval: (calls) => ({
				decisionsByCallId: Object.fromEntries(
					calls.map((call) => [
						call.id,
						call.toolName === 'create_issue' ? { kind: 'call_blocked' } : { kind: 'allow' },
					]),
				),
			}),
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'blocked-create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
						{
							arguments: {},
							id: 'safe-defaulted',
							namespace: 'linear',
							toolName: 'create_issue_with_default',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'blocked-create': {
					error: {
						kind: 'call_blocked',
						message: 'MCP Portal policy does not allow this tool call.',
						namespace: 'linear',
						toolName: 'create_issue',
					},
					ok: false,
				},
				'safe-defaulted': {
					ok: true,
					output: {
						namespace: 'linear',
						toolName: 'create_issue_with_default',
					},
				},
			},
		});

		expect(callUpstreamTool).toHaveBeenCalledTimes(1);
		expect(callUpstreamTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: 'create_issue_with_default',
			}),
		);
	});

	it('returns item-level approval errors when every prepared call requires approval', async () => {
		const callUpstreamTool = vi.fn();
		const handlers = createPortalToolHandlers({
			approval: (calls) => ({
				decisionsByCallId: Object.fromEntries(
					calls.map((call) => [call.id, { kind: 'approval_required', level: 'critical' }]),
				),
			}),
			callUpstreamTool,
			getSession: vi.fn(async () => session),
		});

		await expect(
			handlers.call({
				identity: session.identity,
				input: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'needs-approval',
							namespace: 'linear',
							toolName: 'create_issue',
						},
						{
							arguments: {},
							id: 'defaulted-but-blocked',
							namespace: 'linear',
							toolName: 'create_issue_with_default',
						},
					],
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			results: {
				'defaulted-but-blocked': {
					error: { kind: 'approval_required', level: 'critical' },
					ok: false,
				},
				'needs-approval': {
					error: { kind: 'approval_required', level: 'critical' },
					ok: false,
				},
			},
		});
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
});
