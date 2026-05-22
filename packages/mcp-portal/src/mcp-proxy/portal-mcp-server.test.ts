import { describe, expect, it } from 'vitest';

import { emitMcpProgress, listPortalMcpTools } from './portal-mcp-server.js';

describe('portal MCP server', () => {
	it('exposes exactly the four progressive-disclosure tools', () => {
		expect(listPortalMcpTools().map((tool) => tool.name)).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
	});

	it('uses core-provided scoped descriptors when supplied', () => {
		const tools = listPortalMcpTools([
			{
				description: 'List scoped namespaces: linear.',
				inputSchema: { properties: {}, type: 'object' },
				name: 'mcp_portal_list',
			},
			{
				description: 'Search scoped namespaces: linear.',
				inputSchema: { properties: {}, type: 'object' },
				name: 'mcp_portal_search',
			},
			{
				description: 'Describe scoped namespaces: linear.',
				inputSchema: { properties: {}, type: 'object' },
				name: 'mcp_portal_describe',
			},
			{
				description: 'Call scoped namespaces: linear.',
				inputSchema: { properties: {}, type: 'object' },
				name: 'mcp_portal_call',
			},
		]);

		expect(tools.find((tool) => tool.name === 'mcp_portal_list')?.description).toBe(
			'List scoped namespaces: linear.',
		);
	});

	it('exposes the real input schema for each portal tool', () => {
		const toolsByName = new Map(listPortalMcpTools().map((tool) => [tool.name, tool]));

		expect(toolsByName.get('mcp_portal_list')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				requests: expect.objectContaining({ type: 'array' }),
			},
			required: ['requests'],
			type: 'object',
		});
		expect(toolsByName.get('mcp_portal_search')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				requests: expect.objectContaining({ type: 'array' }),
			},
			required: ['requests'],
			type: 'object',
		});
		expect(toolsByName.get('mcp_portal_describe')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				requests: expect.objectContaining({ type: 'array' }),
			},
			required: ['requests'],
			type: 'object',
		});
		expect(toolsByName.get('mcp_portal_call')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				calls: expect.objectContaining({ type: 'array' }),
			},
			required: ['calls'],
			type: 'object',
		});
		expect(JSON.stringify(toolsByName.get('mcp_portal_call')?.inputSchema)).not.toContain(
			'commitToken',
		);
		expect(JSON.stringify(toolsByName.get('mcp_portal_call')?.inputSchema)).not.toContain(
			'portalApprovalToken',
		);
	});

	it('maps progress events with tokens to MCP progress notifications', async () => {
		const notifications: unknown[] = [];

		await emitMcpProgress({
			event: {
				kind: 'progress',
				message: 'half done',
				progress: 5,
				total: 10,
			},
			progressToken: 'token-a',
			sendNotification: async (notification) => {
				notifications.push(notification);
			},
		});

		expect(notifications).toEqual([
			{
				method: 'notifications/progress',
				params: {
					message: 'half done',
					progress: 5,
					progressToken: 'token-a',
					total: 10,
				},
			},
		]);
	});

	it('falls back to MCP message notifications when no progress token is present', async () => {
		const notifications: unknown[] = [];

		await emitMcpProgress({
			event: {
				kind: 'progress',
				message: 'still working',
			},
			progressToken: undefined,
			sendNotification: async (notification) => {
				notifications.push(notification);
			},
		});

		expect(notifications).toEqual([
			{
				method: 'notifications/message',
				params: {
					data: 'still working',
					level: 'info',
				},
			},
		]);
	});

	it('drops fallback progress messages when the client does not support logging', async () => {
		await expect(
			emitMcpProgress({
				event: {
					kind: 'progress',
					message: 'still working',
				},
				progressToken: undefined,
				sendNotification: async () => {
					throw new Error('Server does not support logging');
				},
			}),
		).resolves.toBeUndefined();
	});

	it('passes through only allowlisted upstream MCP notifications', async () => {
		const notifications: unknown[] = [];
		const sendNotification = async (notification: {
			readonly method: 'notifications/message' | 'notifications/progress';
			readonly params: Record<string, unknown>;
		}): Promise<void> => {
			notifications.push(notification);
		};

		await emitMcpProgress({
			event: {
				kind: 'upstream_notification',
				method: 'notifications/message',
				params: { data: 'from upstream', level: 'info' },
			},
			progressToken: undefined,
			sendNotification,
		});
		await emitMcpProgress({
			event: {
				kind: 'upstream_notification',
				method: 'notifications/progress',
				params: { message: 'from upstream', progress: 2, total: 4 },
			},
			progressToken: 'token-a',
			sendNotification,
		});
		await emitMcpProgress({
			event: {
				kind: 'upstream_notification',
				method: 'notifications/unknown',
				params: { data: 'do not forward' },
			},
			progressToken: undefined,
			sendNotification,
		});

		expect(notifications).toEqual([
			{
				method: 'notifications/message',
				params: { data: 'from upstream', level: 'info' },
			},
			{
				method: 'notifications/progress',
				params: {
					message: 'from upstream',
					progress: 2,
					progressToken: 'token-a',
					total: 4,
				},
			},
		]);
	});
});
