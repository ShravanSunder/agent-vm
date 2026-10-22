import { createServer, type Server as HttpServer } from 'node:http';

import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { z } from 'zod';

export const organizationOne = '11111111-1111-4111-8111-111111111111';
export const organizationTwo = '22222222-2222-4222-8222-222222222222';
export const portalAudience = 'https://portal-test.invalid/mcp';
export const signingKeyHex = '12'.repeat(32);
export const organizationTwoSigningKeyHex = '34'.repeat(32);
const rpcSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
});
export interface RecordedCall {
	readonly credential: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}
export interface ControlledMcpIssuer {
	readonly url: string;
	readonly calls: RecordedCall[];
	readonly discoveryCredentials: string[];
	readonly initializations: string[];
	readonly sign: (props?: {
		readonly organizationId?: string;
		readonly agentId?: string;
		readonly changes?: JWTPayload;
		readonly forge?: boolean;
	}) => Promise<string>;
	readonly close: () => Promise<void>;
	setTools: (count: number, descriptionBytes?: number) => void;
	setCall: (handler: (call: RecordedCall) => Promise<unknown>) => void;
	setCatalog: (tools: readonly Record<string, unknown>[]) => void;
	setUnavailablePath: (path: string, unavailable: boolean) => void;
	setBrokenCalls: (broken: boolean) => void;
	setEarlyCallHeaders: (enabled: boolean) => void;
	setBackgroundStreams: (enabled: boolean) => void;
	readonly activeBackgroundStreams: () => number;
}

/** Test-only sign-in issuer/JWKS stand-in plus controlled legacy MCP server. No real sign-in proof. */
export async function startControlledMcpIssuer(): Promise<ControlledMcpIssuer> {
	const keys = await generateKeyPair('ES256');
	const forgedKeys = await generateKeyPair('ES256');
	const jwks = {
		keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-issuer', alg: 'ES256', use: 'sig' }],
	};
	const calls: RecordedCall[] = [];
	const discoveryCredentials: string[] = [];
	const initializations: string[] = [];
	let tools = toolCatalog(4, 0);
	const unavailablePaths = new Set<string>();
	let brokenCalls = false;
	let earlyCallHeaders = false;
	let backgroundStreams = false;
	let activeBackgroundStreams = 0;
	let callHandler = async (call: RecordedCall): Promise<unknown> => ({
		content: [
			{
				type: 'text',
				text:
					typeof call.arguments.value === 'string' || typeof call.arguments.value === 'number'
						? String(call.arguments.value)
						: 'ok',
			},
		],
	});
	let closed = false;
	const server: HttpServer = createServer((request, response) => {
		void (async () => {
			try {
				response.setHeader('connection', 'close');
				if (request.url === '/jwks') {
					response.setHeader('content-type', 'application/json');
					response.end(JSON.stringify(jwks));
					return;
				}
				if (unavailablePaths.has(request.url ?? '')) {
					response.writeHead(503);
					response.end('controlled unavailable');
					return;
				}
				if (request.method === 'GET' && backgroundStreams) {
					activeBackgroundStreams += 1;
					response.writeHead(200, { 'content-type': 'text/event-stream' });
					response.write(': ready\n\n');
					response.once('close', () => {
						activeBackgroundStreams -= 1;
					});
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
				const credential = request.headers.authorization ?? 'none';
				let result: unknown;
				switch (rpc.method) {
					case 'initialize':
						initializations.push(credential);
						result = {
							protocolVersion: '2025-11-25',
							capabilities: { tools: {} },
							serverInfo: { name: 'controlled', version: '1' },
						};
						break;
					case 'tools/list':
						discoveryCredentials.push(credential);
						result = { tools };
						break;
					case 'tools/call': {
						const params = z
							.object({
								name: z.string(),
								arguments: z.record(z.string(), z.unknown()).default({}),
							})
							.parse(rpc.params);
						const call = { credential, name: params.name, arguments: params.arguments };
						calls.push(call);
						if (brokenCalls) {
							response.destroy();
							return;
						}
						if (earlyCallHeaders) {
							response.writeHead(200, { 'content-type': 'application/json' });
							response.flushHeaders();
						}
						result = await callHandler(call);
						break;
					}
					default:
						if (rpc.id !== undefined) {
							response.setHeader('content-type', 'application/json');
							response.end(
								JSON.stringify({
									jsonrpc: '2.0',
									id: rpc.id,
									error: { code: -32601, message: 'Method not found' },
								}),
							);
						} else {
							response.writeHead(202);
							response.end();
						}
						return;
				}
				if (!response.headersSent) response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
			} catch {
				response.writeHead(500);
				response.end('controlled fixture failed');
			}
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('No fixture address.');
	const url = `http://127.0.0.1:${String(address.port)}`;
	return {
		url,
		calls,
		discoveryCredentials,
		initializations,
		setTools: (count, bytes = 0) => {
			tools = toolCatalog(count, bytes);
		},
		setCall: (handler) => {
			callHandler = handler;
		},
		setCatalog: (catalog) => {
			tools = catalog;
		},
		setUnavailablePath: (path, unavailable) => {
			if (unavailable) unavailablePaths.add(path);
			else unavailablePaths.delete(path);
		},
		setEarlyCallHeaders: (enabled) => {
			earlyCallHeaders = enabled;
		},
		setBrokenCalls: (broken) => {
			brokenCalls = broken;
		},
		setBackgroundStreams: (enabled) => {
			backgroundStreams = enabled;
		},
		activeBackgroundStreams: () => activeBackgroundStreams,
		sign: async (input = {}) => {
			const agentId = input.agentId ?? 'agent-one';
			const now = Math.floor(Date.now() / 1000);
			return new SignJWT({
				iss: url,
				sub: agentId,
				aud: portalAudience,
				exp: now + 3600,
				iat: now,
				scope: 'tool-portal:agent',
				client_id: agentId,
				azp: agentId,
				jti: crypto.randomUUID(),
				organization_id: input.organizationId ?? organizationOne,
				...input.changes,
			})
				.setProtectedHeader({ alg: 'ES256', kid: 'test-issuer', typ: 'at+jwt' })
				.sign(input.forge ? forgedKeys.privateKey : keys.privateKey);
		},
		close: async () => {
			if (closed) return;
			closed = true;
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

function toolCatalog(count: number, descriptionBytes: number): readonly Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => ({
		name: ['read', 'ask', 'hidden', 'blocked'][index] ?? `large-${String(index)}`,
		description: 'd'.repeat(descriptionBytes),
		inputSchema: { type: 'object', properties: { value: {} }, additionalProperties: true },
	}));
}

export function organizationConfigurations(url: string): unknown {
	const configuration = (
		organizationName: string,
		binding: string,
		approvalKeyBinding: string,
	): unknown => ({
		organizationName,
		approvalKeyBinding,
		mcp: {
			schemaVersion: 1,
			providers: {
				fixture: {
					kind: 'mcp',
					namespace: 'same-server',
					transport: {
						kind: 'streamable-http',
						url: `${url}/mcp`,
						headers: { authorization: { source: 'environment', name: binding } },
					},
				},
			},
		},
		portal: {
			schemaVersion: 1,
			agents: { 'agent-one': { profile: 'one' }, 'agent-two': { profile: 'two' } },
			profiles: {
				one: {
					namespaces: {
						'same-server': {
							tools: { allow: '*', deny: ['hidden'] },
							calls: { withoutApproval: { allow: ['read'] }, requiresApproval: { allow: ['ask'] } },
						},
					},
				},
				two: {
					namespaces: {
						'same-server': {
							tools: { allow: ['ask'] },
							calls: { withoutApproval: { allow: ['ask'] }, requiresApproval: { allow: [] } },
						},
					},
				},
			},
		},
	});
	return {
		[organizationOne]: configuration('organization-one', 'ONE_CREDENTIAL', 'ONE_APPROVAL_KEY'),
		[organizationTwo]: configuration('organization-two', 'TWO_CREDENTIAL', 'TWO_APPROVAL_KEY'),
	};
}
