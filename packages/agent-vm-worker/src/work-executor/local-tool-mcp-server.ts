import net from 'node:net';

import { serve } from '@hono/node-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';

import type { ToolDefinition } from './executor-interface.js';

interface LocalToolMcpServer {
	readonly url: string;
}

const localToolServerCache = new Map<string, LocalToolMcpServer>();

function toolSignature(tools: readonly ToolDefinition[]): string {
	return JSON.stringify(
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		})),
	);
}

async function findOpenPort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Could not determine an open port.')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

function createToolDescriptor(tool: ToolDefinition): Tool {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: {
			type: 'object',
			...tool.inputSchema,
		},
	};
}

function normalizeToolResult(result: unknown): CallToolResult {
	if (typeof result === 'object' && result !== null && 'content' in result) {
		return result as CallToolResult;
	}

	return {
		content: [
			{
				type: 'text',
				text: typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? 'null'),
			},
		],
		...(typeof result === 'object' && result !== null
			? { structuredContent: result as Record<string, unknown> }
			: {}),
	};
}

function buildMcpApp(tools: readonly ToolDefinition[]): Hono {
	const toolMap = new Map(tools.map((tool) => [tool.name, tool] as const));
	const app = new Hono();

	app.all('/mcp', async (context) => {
		const transport = new WebStandardStreamableHTTPServerTransport();
		const server = new Server(
			{ name: 'agent-vm-local-tools', version: '1.0.0' },
			{ capabilities: { tools: { listChanged: false } } },
		);

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: tools.map((tool) => createToolDescriptor(tool)),
		}));

		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const tool = toolMap.get(request.params.name);
			if (!tool) {
				return {
					content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
					isError: true,
				};
			}

			try {
				const result = await tool.execute(request.params.arguments ?? {});
				return normalizeToolResult(result);
			} catch (error) {
				return {
					content: [
						{
							type: 'text',
							text: error instanceof Error ? error.message : String(error),
						},
					],
					isError: true,
				};
			}
		});

		await server.connect(transport);
		return await transport.handleRequest(context.req.raw);
	});

	return app;
}

export async function getOrCreateLocalToolMcpServer(
	tools: readonly ToolDefinition[],
): Promise<LocalToolMcpServer | null> {
	if (tools.length === 0) {
		return null;
	}

	const signature = toolSignature(tools);
	const existing = localToolServerCache.get(signature);
	if (existing) {
		return existing;
	}

	const port = await findOpenPort();
	const app = buildMcpApp(tools);
	serve({ fetch: app.fetch, port });

	const server = { url: `http://127.0.0.1:${port}/mcp` };
	localToolServerCache.set(signature, server);
	return server;
}
