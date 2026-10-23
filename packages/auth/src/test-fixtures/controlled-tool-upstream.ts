import { createServer } from 'node:http';

import { z } from 'zod';

const rpcSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
});
export interface ObservedToolEffect {
	readonly credential: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

/** A legacy MCP boundary with an independent effect ledger; this server never issues identity proofs. */
export async function startControlledToolUpstream(): Promise<{
	readonly url: string;
	readonly effects: readonly ObservedToolEffect[];
	readonly close: () => Promise<void>;
}> {
	const effects: ObservedToolEffect[] = [];
	const server = createServer((request, response) => {
		void (async (): Promise<void> => {
			try {
				if (request.method !== 'POST') {
					response.writeHead(405).end();
					return;
				}
				let body = '';
				for await (const chunk of request) body += String(chunk);
				const rpc = rpcSchema.parse(JSON.parse(body));
				let result: unknown;
				switch (rpc.method) {
					case 'initialize':
						result = {
							protocolVersion: '2025-11-25',
							capabilities: { tools: {} },
							serverInfo: { name: 'auth-proof-upstream', version: '1' },
						};
						break;
					case 'tools/list':
						result = {
							tools: [
								{
									name: 'record_effect',
									description: 'Records the correlated proof effect',
									inputSchema: {
										type: 'object',
										properties: { correlation: { type: 'string' } },
										required: ['correlation'],
									},
								},
							],
						};
						break;
					case 'tools/call': {
						const call = z
							.object({
								name: z.literal('record_effect'),
								arguments: z.record(z.string(), z.unknown()),
							})
							.parse(rpc.params);
						effects.push({
							credential: request.headers.authorization ?? 'missing',
							arguments: call.arguments,
						});
						result = { content: [{ type: 'text', text: 'effect-recorded' }] };
						break;
					}
					default:
						if (rpc.id === undefined) response.writeHead(202).end();
						else
							response
								.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
								.end(
									JSON.stringify({
										jsonrpc: '2.0',
										id: rpc.id,
										error: { code: -32601, message: 'Method not found' },
									}),
								);
						return;
				}
				response
					.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
					.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
			} catch {
				response.writeHead(500).end('Controlled MCP boundary refused input');
			}
		})();
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('Controlled MCP listener unavailable');
	return {
		url: `http://127.0.0.1:${address.port}`,
		effects,
		async close(): Promise<void> {
			server.closeAllConnections();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}
