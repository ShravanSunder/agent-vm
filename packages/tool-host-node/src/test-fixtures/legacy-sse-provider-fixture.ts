import { once } from 'node:events';
import { createServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export async function startLegacySseProvider(): Promise<{
	readonly url: string;
	readonly requests: {
		readonly httpMethod: string;
		readonly rpcMethod?: string;
		readonly path: string;
		readonly authorization: string | undefined;
		readonly selectedHeader: string | undefined;
	}[];
	readonly effects: { readonly name: string; readonly arguments: unknown }[];
	readonly close: () => Promise<void>;
}> {
	const requests: {
		httpMethod: string;
		rpcMethod?: string;
		path: string;
		authorization: string | undefined;
		selectedHeader: string | undefined;
	}[] = [];
	const effects: { name: string; arguments: unknown }[] = [];
	const sessions = new Map<string, { server: Server; transport: SSEServerTransport }>();
	const http = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? '/', 'http://legacy.invalid');
			const record = {
				httpMethod: request.method ?? '',
				path: url.pathname,
				authorization: request.headers.authorization,
				selectedHeader:
					typeof request.headers['x-selected-binding'] === 'string'
						? request.headers['x-selected-binding']
						: undefined,
			};
			if (request.method === 'GET' && url.pathname === '/sse') {
				requests.push(record);
				const transport = new SSEServerTransport('/messages', response);
				const server = new Server(
					{ name: 'legacy-sse-only', version: '1' },
					{ capabilities: { tools: {} } },
				);
				server.setRequestHandler(ListToolsRequestSchema, async () => ({
					tools: [{ name: 'read', inputSchema: { type: 'object' } }],
				}));
				server.setRequestHandler(CallToolRequestSchema, async (call, context) => {
					effects.push({ name: call.params.name, arguments: call.params.arguments });
					const token = context['_meta']?.progressToken;
					if (token !== undefined)
						await context.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken: token,
								progress: 1,
								total: 1,
								message: 'legacy network progress',
							},
						});
					return { content: [{ type: 'text', text: 'legacy SSE read once' }] };
				});
				sessions.set(transport.sessionId, { server, transport });
				await server.connect(transport);
				return;
			}
			let parsedBody: unknown;
			if (request.method === 'POST') {
				const chunks: Buffer[] = [];
				for await (const chunk of request)
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
				parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				const body = z.object({ method: z.string() }).passthrough().parse(parsedBody);
				requests.push({ ...record, rpcMethod: body.method });
			} else requests.push(record);
			const session = sessions.get(url.searchParams.get('sessionId') ?? '');
			if (request.method === 'POST' && url.pathname === '/messages' && session !== undefined) {
				await session.transport.handlePostMessage(request, response, parsedBody);
				return;
			}
			response.writeHead(405);
			response.end();
		})().catch(() => response.destroy());
	});
	http.listen(0, '127.0.0.1');
	await once(http, 'listening');
	const address = http.address();
	if (address === null || typeof address === 'string') throw new Error('Missing legacy SSE port.');
	return {
		url: `http://127.0.0.1:${address.port}/sse`,
		requests,
		effects,
		close: async () => {
			await Promise.all([...sessions.values()].map(async ({ server }) => server.close()));
			http.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				http.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		},
	};
}
