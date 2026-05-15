import { describe, expect, it, vi } from 'vitest';

import { createPortalAgentIdentity } from '../portal-access-policy.js';
import type { PortalSession } from '../portal-session.js';
import { createPortalToolHandlers } from './portal-tools.js';

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
		discoveryFailures: [{ message: 'readwise unavailable', namespace: 'readwise' }],
	},
} satisfies PortalSession;

function allowDecision(): { readonly kind: 'allow' } {
	return { kind: 'allow' };
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
				throw new Error('upstream exploded');
			}
			return { content: [{ text: 'created', type: 'text' }] };
		});
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
			}),
		).resolves.toMatchObject({
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
						message: 'upstream exploded',
						namespace: 'linear',
						toolName: 'create_issue',
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

	it('fails closed for the whole batch when approval is required', async () => {
		const callUpstreamTool = vi.fn();
		const handlers = createPortalToolHandlers({
			approval: () => ({ kind: 'approval_required', level: 'critical' }),
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
