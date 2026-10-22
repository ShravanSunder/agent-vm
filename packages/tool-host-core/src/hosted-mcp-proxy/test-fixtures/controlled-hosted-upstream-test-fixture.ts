import { createServer } from 'node:http';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { z } from 'zod';

const rpcSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
});
export interface HostedUpstreamEffect {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
	readonly credential: string;
}
export interface ControlledHostedUpstream {
	readonly url: string;
	readonly effects: readonly HostedUpstreamEffect[];
	readonly sign: () => Promise<string>;
	readonly close: () => Promise<void>;
}

/** Real HTTP MCP provider and JWT/JWKS fixture; no Cloudflare runtime or sign-in service. */
export async function startControlledHostedUpstream(): Promise<ControlledHostedUpstream> {
	const keys = await generateKeyPair('ES256');
	const jwks = {
		keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256', use: 'sig' }],
	};
	const effects: HostedUpstreamEffect[] = [];
	const server = createServer((request, response) => {
		void (async (): Promise<void> => {
			if (request.url === '/jwks') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify(jwks));
				return;
			}
			if (request.method !== 'POST') {
				response.writeHead(405);
				response.end();
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
						serverInfo: { name: 'controlled-upstream', version: '1' },
					};
					break;
				case 'tools/list':
					result = {
						tools: ['read', 'ask'].map((name) => ({
							name,
							description: `${name} a fixture value`,
							inputSchema: {
								type: 'object',
								properties: { value: { type: 'string' } },
								required: ['value'],
								additionalProperties: false,
							},
						})),
					};
					break;
				case 'tools/call': {
					const params = z
						.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })
						.parse(rpc.params);
					effects.push({ ...params, credential: request.headers.authorization ?? 'none' });
					result = {
						content: [
							{ type: 'text', text: `effect:${params.name}:${String(params.arguments.value)}` },
						],
					};
					break;
				}
				default:
					if (rpc.id !== undefined) {
						response.setHeader('content-type', 'application/json');
						response.end(
							JSON.stringify({
								jsonrpc: '2.0',
								id: rpc.id,
								error: { code: -32601, message: `Unknown method: ${rpc.method}` },
							}),
						);
						return;
					}
					response.writeHead(202);
					response.end();
					return;
			}
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
		})().catch(() => {
			response.writeHead(500);
			response.end('controlled fixture failed');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('Missing provider address.');
	const url = `http://127.0.0.1:${String(address.port)}`;
	return {
		url,
		effects,
		sign: async () => {
			const now = Math.floor(Date.now() / 1000);
			return new SignJWT({
				iss: url,
				sub: 'sender',
				client_id: 'sender',
				azp: 'sender',
				aud: 'https://portal.invalid/mcp',
				exp: now + 3600,
				iat: now,
				jti: 'fixture-token',
				scope: 'tool-portal:agent',
				organization_id: '11111111-1111-4111-8111-111111111111',
			})
				.setProtectedHeader({ alg: 'ES256', kid: 'fixture', typ: 'at+jwt' })
				.sign(keys.privateKey);
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		},
	};
}
