import { describe, expect, it } from 'vitest';

import { createBeforeToolCallHandler } from './before-tool-call-handler.js';
import { createPortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

function createRuntimeState(): ReturnType<typeof createPortalPluginRuntimeState> {
	return createPortalPluginRuntimeState({
		configDir: '/config',
		loadPortalConfig: async () => ({
			agents: { shravan: { credentialVersion: 1, profile: 'builder' } },
			profiles: {
				builder: {
					approval: {
						allowWithoutApprovalTools: [{ namespace: 'linear', toolName: 'list_issues' }],
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

	it('requires approval without mutating portal call params', async () => {
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

		expect(result).toMatchObject({ requireApproval: expect.any(Object) });
		expect(params).not.toHaveProperty('portalApprovalToken');
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
