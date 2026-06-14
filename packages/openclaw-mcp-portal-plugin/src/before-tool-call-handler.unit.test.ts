import {
	hashCallArguments,
	type ApprovalTokenCallDigest,
	verifyApprovalToken,
} from '@agent-vm/mcp-portal/portal-auth/hmac-token';
import { describe, expect, it, vi } from 'vitest';

import { createBeforeToolCallHandler } from './before-tool-call-handler.js';
import { createPortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

type ApprovalTokenDigestResolver = NonNullable<
	Parameters<typeof createBeforeToolCallHandler>[0]['resolveApprovalTokenCallDigests']
>;
type BeforeToolCallHandler = ReturnType<typeof createBeforeToolCallHandler>;
type RuntimeState = ReturnType<typeof createPortalPluginRuntimeState>;

function createRuntimeState(): ReturnType<typeof createPortalPluginRuntimeState> {
	return createPortalPluginRuntimeState({
		configDir: '/config',
		loadPortalConfig: async () => ({
			agents: { shravan: { credentialVersion: 1, profile: 'builder' } },
			profiles: {
				builder: {
					namespaces: {
						linear: {
							calls: {
								withoutApproval: { allow: ['list_issues'], deny: [] },
								requiresApproval: { allow: ['create_issue'], deny: [] },
							},
							tools: {
								allow: ['blocked_issue', 'create_issue', 'list_issues'],
								deny: ['hidden_issue'],
							},
						},
					},
				},
			},
			schemaVersion: 1,
		}),
	});
}

function createApprovalTokenDigestResolver(): ApprovalTokenDigestResolver {
	return vi.fn<ApprovalTokenDigestResolver>(async ({ approvalCalls }) =>
		Object.fromEntries(
			approvalCalls.map((call) => [
				call.id,
				{
					argumentsHash: hashCallArguments(call.arguments),
					namespace: call.namespace,
					toolName: call.toolName,
				},
			]),
		),
	);
}

function createHandlerFixture(
	options: {
		readonly resolveApprovalTokenCallDigests?: ApprovalTokenDigestResolver;
		readonly runtimeState?: RuntimeState;
	} = {},
): {
	readonly handler: BeforeToolCallHandler;
	readonly resolveApprovalTokenCallDigests: ApprovalTokenDigestResolver;
	readonly runtimeState: RuntimeState;
} {
	const runtimeState = options.runtimeState ?? createRuntimeState();
	const resolveApprovalTokenCallDigests =
		options.resolveApprovalTokenCallDigests ?? createApprovalTokenDigestResolver();
	return {
		handler: createBeforeToolCallHandler({
			resolveApprovalTokenCallDigests,
			runtimeState,
		}),
		resolveApprovalTokenCallDigests,
		runtimeState,
	};
}

describe('createBeforeToolCallHandler', () => {
	it('passes through non-portal tools', async () => {
		const { handler } = createHandlerFixture();

		await expect(
			handler({ params: {}, toolName: 'shell' }, { agentId: 'shravan' }),
		).resolves.toBeUndefined();
	});

	it('blocks denied namespace or tool calls before approval', async () => {
		const { handler } = createHandlerFixture();

		await expect(
			handler(
				{
					params: {
						calls: [
							{
								arguments: {},
								id: 'hidden',
								namespace: 'linear',
								toolName: 'hidden_issue',
							},
						],
					},
					toolName: 'mcp_portal_call',
				},
				{ agentId: 'shravan' },
			),
		).resolves.toMatchObject({ block: true, blockReason: expect.stringContaining('not enabled') });
	});

	it('blocks portal calls when OpenClaw does not provide agent context', async () => {
		const { handler } = createHandlerFixture();

		await expect(
			handler(
				{
					params: {
						calls: [
							{
								arguments: {},
								id: 'create',
								namespace: 'linear',
								toolName: 'create_issue',
							},
						],
					},
					toolName: 'mcp_portal_call',
				},
				{},
			),
		).resolves.toMatchObject({
			block: true,
			blockReason: expect.stringContaining('missing OpenClaw agent context'),
		});
	});

	it('injects an approval token for the approval-required subset of a mixed approval-free batch', async () => {
		const { handler, resolveApprovalTokenCallDigests, runtimeState } = createHandlerFixture();
		const approvalSubsetDigest: ApprovalTokenCallDigest[] = [
			{
				argumentsHash: hashCallArguments({ title: 'Fix deploy' }),
				namespace: 'linear',
				toolName: 'create_issue',
			},
		];

		const result = await handler(
			{
				params: {
					calls: [
						{
							arguments: { query: 'deploy' },
							id: 'list',
							namespace: 'linear',
							toolName: 'list_issues',
						},
						{
							arguments: { title: 'Fix deploy' },
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				toolName: 'mcp_portal_call',
			},
			{ agentId: 'shravan' },
		);

		expect(resolveApprovalTokenCallDigests).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalCalls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
			}),
		);
		expect(result).toMatchObject({
			params: { portalApprovalToken: expect.any(String) },
			requireApproval: expect.objectContaining({
				description: expect.not.stringContaining('list: linear.list_issues'),
				title: 'MCP Portal batch: linear.create_issue',
			}),
		});
		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: approvalSubsetDigest,
				key: runtimeState.getApprovalHmacKey(),
				maxLifetimeMs: 5 * 60_000,
				nowMs: Date.now(),
				token: result?.params?.portalApprovalToken as string,
			}),
		).toEqual({ ok: true });
	});

	it('injects an approval token when an approval-required call has a blocked visible sibling', async () => {
		const { handler, resolveApprovalTokenCallDigests } = createHandlerFixture();

		const result = await handler(
			{
				params: {
					calls: [
						{
							arguments: { query: 'deploy' },
							id: 'blocked',
							namespace: 'linear',
							toolName: 'blocked_issue',
						},
						{
							arguments: { title: 'Fix deploy' },
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				toolName: 'mcp_portal_call',
			},
			{ agentId: 'shravan' },
		);

		expect(resolveApprovalTokenCallDigests).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalCalls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
			}),
		);
		expect(result).toMatchObject({
			params: { portalApprovalToken: expect.any(String) },
			requireApproval: expect.objectContaining({ title: 'MCP Portal batch: linear.create_issue' }),
		});
	});

	it('injects an approval token when an approval-required call has a hidden sibling', async () => {
		const { handler, resolveApprovalTokenCallDigests } = createHandlerFixture();

		const result = await handler(
			{
				params: {
					calls: [
						{
							arguments: {},
							id: 'hidden',
							namespace: 'linear',
							toolName: 'hidden_issue',
						},
						{
							arguments: { title: 'Fix deploy' },
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				toolName: 'mcp_portal_call',
			},
			{ agentId: 'shravan' },
		);

		expect(resolveApprovalTokenCallDigests).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalCalls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
			}),
		);
		expect(result).toMatchObject({
			params: { portalApprovalToken: expect.any(String) },
			requireApproval: expect.objectContaining({ title: 'MCP Portal batch: linear.create_issue' }),
		});
	});

	it('passes through mixed batches when approval-required calls cannot be prepared by core', async () => {
		const { handler } = createHandlerFixture({
			resolveApprovalTokenCallDigests: async () => ({
				create: {
					argumentsHash: hashCallArguments({ title: 'Fix deploy' }),
					namespace: 'linear',
					toolName: 'create_issue',
				},
			}),
		});

		await expect(
			handler(
				{
					params: {
						calls: [
							{
								arguments: { query: 'deploy' },
								id: 'list',
								namespace: 'linear',
								toolName: 'list_issues',
							},
							{
								arguments: { title: 42 },
								id: 'invalid-create',
								namespace: 'linear',
								toolName: 'create_issue',
							},
						],
					},
					toolName: 'mcp_portal_call',
				},
				{ agentId: 'shravan' },
			),
		).resolves.toBeUndefined();
	});

	it('injects a portal approval token for homogeneous approval batches', async () => {
		const { handler } = createHandlerFixture();
		const params: Record<string, unknown> = {
			calls: [
				{
					arguments: { title: 'Fix deploy' },
					id: 'create',
					namespace: 'linear',
					toolName: 'create_issue',
				},
			],
		};

		const result = await handler({ params, toolName: 'mcp_portal_call' }, { agentId: 'shravan' });

		expect(result).toMatchObject({
			params: {
				portalApprovalToken: expect.any(String),
			},
			requireApproval: expect.objectContaining({
				pluginId: 'mcp-portal',
				title: expect.stringContaining('MCP Portal batch'),
			}),
		});
		expect(params).not.toHaveProperty('portalApprovalToken');
	});

	it('injects a portal approval token when OpenClaw passes stringified params', async () => {
		const { handler } = createHandlerFixture();
		const params = JSON.stringify({
			calls: [
				{
					arguments: { title: 'Fix deploy' },
					id: 'create',
					namespace: 'linear',
					toolName: 'create_issue',
				},
			],
		}) as unknown as Record<string, unknown>;

		const result = await handler({ params, toolName: 'mcp_portal_call' }, { agentId: 'shravan' });

		expect(result).toMatchObject({
			params: {
				calls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
				portalApprovalToken: expect.any(String),
			},
			requireApproval: expect.objectContaining({
				pluginId: 'mcp-portal',
			}),
		});
	});

	it('uses prepared approval token digests from core validation', async () => {
		const runtimeState = createRuntimeState();
		const defaultedArguments = { title: 'Default title' };
		const resolvedDigests = {
			create: {
				argumentsHash: hashCallArguments(defaultedArguments),
				namespace: 'linear',
				toolName: 'create_issue',
			},
		};
		const handler = createBeforeToolCallHandler({
			resolveApprovalTokenCallDigests: async () => resolvedDigests,
			runtimeState,
		});

		const result = await handler(
			{
				params: {
					calls: [
						{
							arguments: {},
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				toolName: 'mcp_portal_call',
			},
			{ agentId: 'shravan' },
		);

		expect(result?.params?.portalApprovalToken).toEqual(expect.any(String));
		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: Object.values(resolvedDigests),
				key: runtimeState.getApprovalHmacKey(),
				maxLifetimeMs: 5 * 60_000,
				nowMs: Date.now(),
				token: result?.params?.portalApprovalToken as string,
			}),
		).toEqual({ ok: true });
	});

	it('blocks approval prompts when token digest preparation fails', async () => {
		const { handler } = createHandlerFixture({
			resolveApprovalTokenCallDigests: async () => {
				throw new Error('catalog unavailable');
			},
		});

		await expect(
			handler(
				{
					params: {
						calls: [
							{
								arguments: { title: 'Fix deploy' },
								id: 'create',
								namespace: 'linear',
								toolName: 'create_issue',
							},
						],
					},
					toolName: 'mcp_portal_call',
				},
				{ agentId: 'shravan' },
			),
		).resolves.toMatchObject({
			block: true,
			blockReason: expect.stringContaining('failed to prepare approval token'),
		});
	});

	it('keeps injected approval tokens valid after the approval prompt timeout boundary', async () => {
		vi.useFakeTimers();
		try {
			const issuedAt = new Date('2026-05-25T00:00:00.000Z');
			vi.setSystemTime(issuedAt);
			const { handler, runtimeState } = createHandlerFixture();
			const callArguments = { title: 'Fix deploy' };

			const result = await handler(
				{
					params: {
						calls: [
							{
								arguments: callArguments,
								id: 'create',
								namespace: 'linear',
								toolName: 'create_issue',
							},
						],
					},
					toolName: 'mcp_portal_call',
				},
				{ agentId: 'shravan' },
			);

			expect(result?.params?.portalApprovalToken).toEqual(expect.any(String));
			const verification = verifyApprovalToken({
				agentId: 'shravan',
				calls: [
					{
						argumentsHash: hashCallArguments(callArguments),
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
				key: runtimeState.getApprovalHmacKey(),
				maxLifetimeMs: 5 * 60_000,
				nowMs: issuedAt.getTime() + 60_001,
				token: result?.params?.portalApprovalToken as string,
			});
			expect(verification).toEqual({ ok: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it('allows calls that are enabled and do not require approval', async () => {
		const { handler } = createHandlerFixture();

		await expect(
			handler(
				{
					params: {
						calls: [
							{
								arguments: { query: 'deploy' },
								id: 'list',
								namespace: 'linear',
								toolName: 'list_issues',
							},
						],
					},
					toolName: 'mcp_portal_call',
				},
				{ agentId: 'shravan' },
			),
		).resolves.toBeUndefined();
	});
});
