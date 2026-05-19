import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { createPortalCore, collectPortalCoreResult, type PortalCoreEvent } from './portal-core.js';

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

function allowApproval(): { readonly kind: 'allow' } {
	return { kind: 'allow' };
}

describe('portal core event stream', () => {
	it('creates trusted agent scopes with adapter source and OpenClaw session fields', async () => {
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
			source: 'openclaw-trusted',
		});

		expect(scope).toMatchObject({
			agentId: 'agent-a',
			agentScopeId: 'agent-scope-a',
			sessionId: 'session-id-a',
			sessionKey: 'session-key-a',
			source: 'openclaw-trusted',
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

	it('streams batch item progress and collects success and failure results', async () => {
		const callUpstreamTool = vi.fn(async (call: { readonly toolName: string }) => {
			if (call.toolName === 'explode') {
				throw new Error('upstream failed deliberately');
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
						message: 'upstream failed deliberately',
						namespace: 'linear',
						toolName: 'explode',
					},
					requestId: 'bad-call',
					status: 'failed',
				},
			],
		});
		expect(callUpstreamTool).toHaveBeenCalledTimes(2);

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

	it('evaluates approval once for the full batch before upstream contact', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const approval = vi.fn((calls: readonly { readonly id: string }[]) => {
			void calls;
			return { kind: 'approval_required', level: 'standard' } as const;
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
		const failed = await Promise.race([
			iterator.next(),
			new Promise<IteratorResult<PortalCoreEvent>>((_, reject) => {
				setTimeout(() => reject(new Error('aborted batch stream did not wake')), 250);
			}),
		]);

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
		const failed = await Promise.race([
			iterator.next(),
			new Promise<IteratorResult<PortalCoreEvent>>((_, reject) => {
				setTimeout(() => reject(new Error('aborted scalar stream did not wake')), 250);
			}),
		]);

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
