import {
	hashCallArguments,
	type ApprovalTokenCallDigest,
	verifyApprovalToken,
} from '@agent-vm/mcp-portal/portal-auth/hmac-token';
import { describe, expect, it, vi } from 'vitest';

import { createBeforeToolCallHandler } from './before-tool-call-handler.js';
import { createPortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

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

describe('createBeforeToolCallHandler', () => {
	it('passes through non-portal tools', async () => {
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

		await expect(
			handler({ params: {}, toolName: 'shell' }, { agentId: 'shravan' }),
		).resolves.toBeUndefined();
	});

	it('blocks denied namespace or tool calls before approval', async () => {
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

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
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

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

	it('passes mixed batches through so core can fail only gated calls', async () => {
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

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
		).resolves.toBeUndefined();
	});

	it('passes mixed batches through when one visible call is blocked by call policy', async () => {
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

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
								arguments: { query: 'deploy' },
								id: 'blocked',
								namespace: 'linear',
								toolName: 'blocked_issue',
							},
						],
					},
					toolName: 'mcp_portal_call',
				},
				{ agentId: 'shravan' },
			),
		).resolves.toBeUndefined();
	});

	it('passes mixed batches through when one sibling is hidden', async () => {
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

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
		).resolves.toBeUndefined();
	});

	it('injects a portal approval token for homogeneous approval batches', async () => {
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });
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
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });
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
		const resolvedDigests: ApprovalTokenCallDigest[] = [
			{
				argumentsHash: hashCallArguments(defaultedArguments),
				namespace: 'linear',
				toolName: 'create_issue',
			},
		];
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
				calls: resolvedDigests,
				key: runtimeState.getApprovalHmacKey(),
				maxLifetimeMs: 5 * 60_000,
				nowMs: Date.now(),
				token: result?.params?.portalApprovalToken as string,
			}),
		).toEqual({ ok: true });
	});

	it('blocks approval prompts when token digest preparation fails', async () => {
		const handler = createBeforeToolCallHandler({
			resolveApprovalTokenCallDigests: async () => {
				throw new Error('catalog unavailable');
			},
			runtimeState: createRuntimeState(),
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
			const runtimeState = createRuntimeState();
			const handler = createBeforeToolCallHandler({ runtimeState });
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
		const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

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
