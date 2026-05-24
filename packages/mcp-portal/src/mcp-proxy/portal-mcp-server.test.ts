import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { createPortalCore } from '../core/portal-core.js';
import { UpstreamMcpError } from '../upstream-mcp-errors.js';
import { createPortalMcpServer, emitMcpProgress, listPortalMcpTools } from './portal-mcp-server.js';

type CapturedCallToolHandler = (
	request: {
		readonly method: 'tools/call';
		readonly params: {
			readonly arguments?: Readonly<Record<string, unknown>>;
			readonly name: string;
		};
	},
	extra: {
		readonly _meta?: { readonly progressToken?: number | string };
		readonly sendNotification: (notification: {
			readonly method: 'notifications/message' | 'notifications/progress';
			readonly params: Record<string, unknown>;
		}) => Promise<void>;
		readonly signal: AbortSignal;
	},
) => Promise<CallToolResult>;

function captureCallToolHandler(registerServer: () => void): CapturedCallToolHandler {
	let capturedHandler: CapturedCallToolHandler | undefined;
	const setRequestHandler = vi
		.spyOn(Server.prototype, 'setRequestHandler')
		.mockImplementation((schema, handler) => {
			if (schema === CallToolRequestSchema) {
				capturedHandler = handler as unknown as CapturedCallToolHandler;
			}
		});
	try {
		registerServer();
	} finally {
		setRequestHandler.mockRestore();
	}
	if (capturedHandler === undefined) {
		throw new Error('CallToolRequestSchema handler was not registered.');
	}
	return capturedHandler;
}

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

	it('returns structured diagnostics through direct MCP proxy calls', async () => {
		const core = createPortalCore({
			accessPolicy: {
				enabledNamespaces: ['firecrawl'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: () => ({ kind: 'allow' }),
			catalogTtlMs: 60_000,
			runtime: {
				callUpstreamTool: vi.fn(),
				closeAgentScope: vi.fn(),
				closeSession: vi.fn(),
				listTools: vi.fn(async () => {
					throw new UpstreamMcpError({
						causeMessage: 'operation timed out',
						elapsedMs: 30_001,
						hint: 'MCP provider connected but tool discovery failed; run agent-vm validate --mcp-live for the configured namespace.',
						kind: 'upstream_mcp_failed',
						namespace: 'firecrawl',
						operation: 'MCP listTools',
						phase: 'list_tools',
						timeoutMs: 30_000,
						transport: { argCount: 2, command: 'npx', kind: 'stdio' },
					});
				}),
			},
			upstreamNamespaces: ['firecrawl'],
		});
		const scope = core.createAgentScope({
			agentId: 'agent-a',
			agentScopeId: 'agent-a',
			source: 'cli-operator',
		});
		const callToolHandler = captureCallToolHandler(() => {
			createPortalMcpServer({ core, scope });
		});

		const result = await callToolHandler(
			{
				method: 'tools/call',
				params: {
					arguments: { requests: [{ id: 'list' }] },
					name: 'mcp_portal_list',
				},
			},
			{
				sendNotification: async () => undefined,
				signal: new AbortController().signal,
			},
		);
		const content = result.content[0];
		const payload =
			content?.type === 'text' ? (JSON.parse(content.text) as Record<string, unknown>) : {};

		expect(result.isError).toBeUndefined();
		expect(payload).toMatchObject({
			auditEvents: [
				{
					kind: 'upstream_mcp_failed',
					namespace: 'firecrawl',
					phase: 'list_tools',
				},
			],
			structuredContent: {
				diagnostics: [
					{
						hint: expect.stringContaining('validate --mcp-live'),
						namespace: 'firecrawl',
						phase: 'list_tools',
					},
				],
			},
		});
		await core.close();
	});
});
