import {
	PortalBackendDescribeResultSchema,
	PortalBackendListResultSchema,
	PortalBackendSearchResultSchema,
	PortalCallResultSchema,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
	createBackendFixture,
	githubTools,
} from '#gateway-runtime/backends/managed-mcp-provider-test-fixture';

describe('managed MCP provider discovery', () => {
	it('describes a remote MCP tool without an optional output schema', async () => {
		// Arrange
		const backend = await createBackendFixture();

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
	it('lists and searches projected upstream MCP capabilities without portal tool names', async () => {
		const backend = await createBackendFixture();

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
		const backend = await createBackendFixture();

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
		const backend = await createBackendFixture({
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
	it('maps degraded MCP namespaces to provider unavailable on the capability surface', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = await createBackendFixture({
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
});
