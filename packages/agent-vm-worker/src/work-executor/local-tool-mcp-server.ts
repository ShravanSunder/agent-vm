import net from 'node:net';

import type { ServerType } from '@hono/node-server';
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
	readonly close: () => Promise<void>;
}

const localToolServerCache = new Map<string, LocalToolMcpServer>();
let registeredCleanup = false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCallToolContentItem(value: unknown): boolean {
	if (!isPlainObject(value) || typeof value.type !== 'string') {
		return false;
	}

	switch (value.type) {
		case 'text':
			return typeof value.text === 'string';
		case 'image':
			return typeof value.data === 'string' && typeof value.mimeType === 'string';
		case 'audio':
			return typeof value.data === 'string' && typeof value.mimeType === 'string';
		case 'resource':
			return isPlainObject(value.resource);
		case 'resource_link':
			return typeof value.uri === 'string' && typeof value.name === 'string';
		default:
			return false;
	}
}

function isCallToolResult(value: unknown): value is CallToolResult {
	if (!isPlainObject(value) || !Array.isArray(value.content)) {
		return false;
	}

	if (!value.content.every((item) => isCallToolContentItem(item))) {
		return false;
	}

	if ('isError' in value && value.isError !== undefined && typeof value.isError !== 'boolean') {
		return false;
	}

	if (
		'structuredContent' in value &&
		value.structuredContent !== undefined &&
		!isPlainObject(value.structuredContent)
	) {
		return false;
	}

	return true;
}

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
	if (isCallToolResult(result)) {
		return result;
	}

	return {
		content: [
			{
				type: 'text',
				text: typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? 'null'),
			},
		],
		...(isPlainObject(result) ? { structuredContent: result } : {}),
	};
}

function buildMcpApp(tools: readonly ToolDefinition[]): Hono {
	const toolMap = new Map<string, ToolDefinition>();
	for (const tool of tools) {
		toolMap.set(tool.name, tool);
	}
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
	const serverHandle: ServerType = serve({ fetch: app.fetch, port });

	if (!registeredCleanup) {
		const closeAllServers = (): void => {
			for (const server of localToolServerCache.values()) {
				void server.close();
			}
			localToolServerCache.clear();
		};
		process.once('exit', closeAllServers);
		process.once('SIGINT', () => {
			closeAllServers();
			process.exit(130);
		});
		process.once('SIGTERM', () => {
			closeAllServers();
			process.exit(143);
		});
		registeredCleanup = true;
	}

	const server = {
		url: `http://127.0.0.1:${port}/mcp`,
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject) => {
				serverHandle.close((error?: Error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
	};
	localToolServerCache.set(signature, server);
	return server;
}
