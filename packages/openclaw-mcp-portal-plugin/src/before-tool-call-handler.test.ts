import {
	hashCallArguments,
	verifyApprovalToken,
	type ApprovalTokenCallDigest,
} from '@agent-vm/mcp-portal';
import { describe, expect, it } from 'vitest';

import { createBeforeToolCallHandler } from './before-tool-call-handler.js';
import { createHmacKeyRegistry } from './hmac-key-registry.js';
import { createPortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

function createRuntimeState(): ReturnType<typeof createPortalPluginRuntimeState> {
	const state = createPortalPluginRuntimeState({
		configDir: '/config',
		loadPortalConfig: async () => ({
			agents: { shravan: { profile: 'builder' } },
			profiles: {
				builder: {
					approval: {
						allowWithoutApprovalTools: [],
						alwaysAskTools: [{ namespace: 'linear', toolName: 'create_issue' }],
						annotationPolicy: 'destructive-requires-approval',
						trustedAnnotationNamespaces: [],
						writeTools: [],
					},
					enabledNamespaces: ['linear'],
					enabledToolsByNamespace: { linear: ['create_issue', 'list_issues'] },
					hiddenToolsByNamespace: { linear: ['hidden_issue'] },
				},
			},
			schemaVersion: 1,
			server: {
				accessHeader: {
					name: 'x-secret',
					secret: { name: 'MCP_PORTAL_SECRET', source: 'environment' },
				},
				host: '127.0.0.1',
				port: 18_790,
			},
		}),
	});
	state.setKeyRegistry(createHmacKeyRegistry({ agentIds: ['shravan'] }));
	return state;
}

function createRuntimeStateWithTrustedAnnotations(): ReturnType<
	typeof createPortalPluginRuntimeState
> {
	const state = createPortalPluginRuntimeState({
		configDir: '/config',
		loadPortalConfig: async () => ({
			agents: { shravan: { profile: 'builder' } },
			profiles: {
				builder: {
					approval: {
						allowWithoutApprovalTools: [],
						alwaysAskTools: [],
						annotationPolicy: 'destructive-requires-approval',
						trustedAnnotationNamespaces: ['linear'],
						writeTools: [],
					},
					enabledNamespaces: ['linear'],
					enabledToolsByNamespace: { linear: ['list_issues'] },
					hiddenToolsByNamespace: {},
				},
			},
			schemaVersion: 1,
			server: {
				accessHeader: {
					name: 'x-secret',
					secret: { name: 'MCP_PORTAL_SECRET', source: 'environment' },
				},
				host: '127.0.0.1',
				port: 18_790,
			},
		}),
	});
	state.setKeyRegistry(createHmacKeyRegistry({ agentIds: ['shravan'] }));
	return state;
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
					toolName: 'mcp_portal_shravan__mcp_portal_call',
				},
				{ agentId: 'shravan' },
			),
		).resolves.toMatchObject({ block: true, blockReason: expect.stringContaining('not enabled') });
	});

	it('attaches one root approval token for approval-required batches', async () => {
		const runtimeState = createRuntimeState();
		const handler = createBeforeToolCallHandler({ runtimeState });
		const argumentsValue = { title: 'Fix deploy' };
		const params: Record<string, unknown> = {
			calls: [
				{
					arguments: argumentsValue,
					id: 'create',
					namespace: 'linear',
					toolName: 'create_issue',
				},
			],
		};

		const result = await handler(
			{ params, toolName: 'mcp_portal_shravan__mcp_portal_call' },
			{ agentId: 'shravan' },
		);
		const token = params.portalApprovalToken;
		const expectedCalls = [
			{
				argumentsHash: hashCallArguments(argumentsValue),
				namespace: 'linear',
				toolName: 'create_issue',
			},
		] satisfies readonly ApprovalTokenCallDigest[];

		expect(result).toMatchObject({ requireApproval: expect.any(Object) });
		expect(typeof token).toBe('string');
		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: expectedCalls,
				key: runtimeState.getKeyRegistry().getKey('shravan'),
				nowMs: Date.now(),
				token: typeof token === 'string' ? token : '',
			}),
		).toEqual({ ok: true });
	});

	it('attaches approval tokens for trusted annotation namespaces', async () => {
		const runtimeState = createRuntimeStateWithTrustedAnnotations();
		const handler = createBeforeToolCallHandler({ runtimeState });
		const argumentsValue = { query: 'deployment' };
		const params: Record<string, unknown> = {
			calls: [
				{
					arguments: argumentsValue,
					id: 'list',
					namespace: 'linear',
					toolName: 'list_issues',
				},
			],
		};

		const result = await handler(
			{ params, toolName: 'mcp_portal_shravan__mcp_portal_call' },
			{ agentId: 'shravan' },
		);
		const token = params.portalApprovalToken;
		const expectedCalls = [
			{
				argumentsHash: hashCallArguments(argumentsValue),
				namespace: 'linear',
				toolName: 'list_issues',
			},
		] satisfies readonly ApprovalTokenCallDigest[];

		expect(result).toMatchObject({ requireApproval: expect.any(Object) });
		expect(typeof token).toBe('string');
		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: expectedCalls,
				key: runtimeState.getKeyRegistry().getKey('shravan'),
				nowMs: Date.now(),
				token: typeof token === 'string' ? token : '',
			}),
		).toEqual({ ok: true });
	});
});
