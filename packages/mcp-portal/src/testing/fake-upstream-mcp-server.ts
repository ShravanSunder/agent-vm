import { serve, type ServerType } from '@hono/node-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Hono, type Context } from 'hono';

export const fakeUpstreamNamespace = 'upstream-mock';

export interface FakeUpstreamToolCallRecord {
	readonly argumentsValue: unknown;
	readonly name: string;
}

export interface FakeUpstreamHttpRequestRecord {
	readonly jsonRpcMethods: readonly string[];
	readonly method: string;
	readonly path: string;
}

export interface StartedFakeUpstreamMcpServer {
	readonly calls: readonly FakeUpstreamToolCallRecord[];
	readonly close: () => Promise<void>;
	readonly firstListToolsRequest: Promise<void>;
	readonly requests: readonly FakeUpstreamHttpRequestRecord[];
	readonly port: number;
	readonly url: string;
}

export interface FakeUpstreamMcpServerOptions {
	readonly callHttpStatusCode?: 400 | 401 | 403 | 429 | 500;
	readonly callHttpStatusToolName?: string;
	readonly emptyTools?: boolean;
	readonly emitProgress?: boolean;
	readonly toolErrorMessageByToolName?: Readonly<Record<string, string>>;
}

interface StartedHonoServer {
	readonly port: number;
	readonly server: ServerType;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonRpcMethodsFromRequest(context: Context): Promise<readonly string[]> {
	if (context.req.method !== 'POST') {
		return [];
	}
	try {
		const body = await context.req.raw.clone().json();
		const messages = Array.isArray(body) ? body : [body];
		return messages.flatMap((message) => {
			if (!isObjectRecord(message) || typeof message['method'] !== 'string') {
				return [];
			}
			return [message['method']];
		});
	} catch {
		return [];
	}
}

async function closeServer(server: ServerType): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function serveHonoOnOpenPort(app: Hono): Promise<StartedHonoServer> {
	return await new Promise<StartedHonoServer>((resolve) => {
		const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
			resolve({ port: info.port, server });
		});
	});
}

function createToolResult(name: string, argumentsValue: unknown): CallToolResult {
	return {
		content: [
			{
				text: JSON.stringify({ arguments: argumentsValue, name, ok: true }),
				type: 'text',
			},
		],
		structuredContent: { name, ok: true },
	};
}

export function createFakeUpstreamTools(): readonly Tool[] {
	return [
		{
			annotations: { destructiveHint: false, readOnlyHint: true },
			description: 'Reads a mock record.',
			inputSchema: {
				additionalProperties: false,
				properties: { title: { type: 'string' } },
				required: ['title'],
				type: 'object',
			},
			name: 'read_thing',
		},
		{
			annotations: { destructiveHint: true },
			description: 'Writes a mock record.',
			inputSchema: {
				additionalProperties: false,
				properties: { title: { type: 'string' } },
				required: ['title'],
				type: 'object',
			},
			name: 'write_thing',
		},
	] satisfies readonly Tool[];
}

export async function startFakeUpstreamMcpServer(
	options: FakeUpstreamMcpServerOptions = {},
): Promise<StartedFakeUpstreamMcpServer> {
	const calls: FakeUpstreamToolCallRecord[] = [];
	const requests: FakeUpstreamHttpRequestRecord[] = [];
	let resolveFirstListToolsRequest: (() => void) | undefined;
	const firstListToolsRequest = new Promise<void>((resolve) => {
		resolveFirstListToolsRequest = resolve;
	});
	let hasObservedListToolsRequest = false;
	const tools = options.emptyTools === true ? [] : createFakeUpstreamTools();
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const app = new Hono();

	app.use('*', async (context, next) => {
		requests.push({
			jsonRpcMethods: await readJsonRpcMethodsFromRequest(context),
			method: context.req.method,
			path: context.req.path,
		});
		await next();
	});

	app.all('/mcp', async (context) => {
		const requestMethods = await readJsonRpcMethodsFromRequest(context);
		const requestBody = await context.req.raw
			.clone()
			.json()
			.catch(() => undefined);
		const calledToolName =
			isObjectRecord(requestBody) &&
			isObjectRecord(requestBody['params']) &&
			typeof requestBody['params']['name'] === 'string'
				? requestBody['params']['name']
				: undefined;
		if (
			options.callHttpStatusCode !== undefined &&
			requestMethods.includes('tools/call') &&
			(options.callHttpStatusToolName === undefined ||
				calledToolName === options.callHttpStatusToolName)
		) {
			return context.text('provider response detail must not escape', options.callHttpStatusCode);
		}
		const transport = new WebStandardStreamableHTTPServerTransport();
		const server = new Server(
			{ name: 'portal-upstream-fixture', version: '1.0.0' },
			{ capabilities: { tools: { listChanged: false } } },
		);

		server.setRequestHandler(ListToolsRequestSchema, async () => {
			if (!hasObservedListToolsRequest) {
				hasObservedListToolsRequest = true;
				resolveFirstListToolsRequest?.();
			}
			return { tools };
		});
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const tool = toolsByName.get(request.params.name);
			if (tool === undefined) {
				return {
					content: [{ text: `Unknown tool ${request.params.name}`, type: 'text' }],
					isError: true,
				};
			}
			const toolErrorMessage = options.toolErrorMessageByToolName?.[tool.name];
			if (toolErrorMessage !== undefined) {
				return {
					content: [{ text: toolErrorMessage, type: 'text' }],
					isError: true,
				};
			}
			const progressToken = extra['_meta']?.progressToken;
			if (options.emitProgress === true && progressToken !== undefined) {
				await extra.sendNotification({
					method: 'notifications/progress',
					params: {
						message: 'fake upstream half done',
						progress: 1,
						progressToken,
						total: 2,
					},
				});
			}
			const argumentsValue = isObjectRecord(request.params.arguments)
				? request.params.arguments
				: {};
			calls.push({ argumentsValue, name: tool.name });
			return createToolResult(tool.name, argumentsValue);
		});

		await server.connect(transport);
		return await transport.handleRequest(context.req.raw);
	});

	const startedServer = await serveHonoOnOpenPort(app);
	return {
		calls,
		close: async () => {
			await closeServer(startedServer.server);
		},
		firstListToolsRequest,
		port: startedServer.port,
		requests,
		url: `http://127.0.0.1:${String(startedServer.port)}/mcp`,
	};
}
