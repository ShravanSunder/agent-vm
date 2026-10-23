import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	type CallToolResult,
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
	nodeHostConfigSchema,
	type NodeHostConfig,
} from '#node-host/host-configuration/models/node-host-config';
import { compileNodeHostCredentialSet } from '#node-host/mcp-proxy-server/bearer-credentials';

export const secretCanary = 'provider-secret-canary-841';
export const headerCanary = 'provider-header-canary-243';
export const revision = { owner: 'configured-host', revision: 'v1' };
export const toolInputSchema = {
	type: 'object' as const,
	properties: { value: { type: 'integer' }, profile: { type: 'string' } },
	required: ['value'],
	additionalProperties: false,
};

export interface ControlledProvider {
	readonly url: string;
	readonly listings: string[];
	readonly protocolMessages: string[];
	readonly httpMethods: string[];
	readonly legacySseRequests: number;
	readonly effects: {
		readonly name: string;
		readonly arguments: unknown;
		readonly authorization: string | undefined;
		readonly selectedHeader: string | undefined;
	}[];
	readonly close: () => Promise<void>;
	readonly setDiscoveryFailure: (failed: boolean) => void;
	readonly setCallResult: (result: CallToolResult) => void;
	readonly breakCalls: () => void;
	readonly duplicateDiscovery: () => void;
	readonly holdCalls: () => { readonly entered: Promise<void>; readonly release: () => void };
	readonly holdDiscovery: () => { readonly entered: Promise<void>; readonly release: () => void };
}

export async function startControlledProvider(
	label: string,
	catalog?: readonly import('@modelcontextprotocol/sdk/types.js').Tool[],
	port = 0,
): Promise<ControlledProvider> {
	const listings: string[] = [];
	const protocolMessages: string[] = [];
	const httpMethods: string[] = [];
	let legacySseRequests = 0;
	const effects: ControlledProvider['effects'] = [];
	const servers = new Set<Server>();
	let duplicates = false;
	let discoveryFailed = false;
	let breakCalls = false;
	let callResult: CallToolResult | undefined;
	let enteredCall: (() => void) | undefined;
	let callGate: Promise<void> = Promise.resolve();
	let enteredDiscovery: (() => void) | undefined;
	let discoveryGate: Promise<void> = Promise.resolve();
	const http = createServer((request, response) => {
		if (request.method === 'GET') legacySseRequests++;
		const advertisedMethod = request.headers['mcp-method'];
		if (typeof advertisedMethod === 'string') httpMethods.push(advertisedMethod);
		const handle = async (): Promise<void> => {
			const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
			const server = new Server(
				{ name: `provider-${label}`, version: '1.0.0' },
				{ capabilities: { tools: {} } },
			);
			servers.add(server);
			server.setRequestHandler(ListToolsRequestSchema, async () => {
				listings.push(label);
				enteredDiscovery?.();
				await discoveryGate;
				if (discoveryFailed)
					throw new Error(`discovery unavailable ${secretCanary} ${headerCanary}`);
				return {
					tools:
						catalog ??
						(duplicates ? ['read', 'read'] : ['read', 'ask', 'blocked', 'hidden', 'fail']).map(
							(name) => ({
								name,
								inputSchema: toolInputSchema,
								description: `${label} ${secretCanary} ${headerCanary}`,
							}),
						),
				};
			});
			server.setRequestHandler(CallToolRequestSchema, async (call) => {
				const selectedHeader = request.headers['x-selected-binding'];
				effects.push({
					name: call.params.name,
					arguments: call.params.arguments,
					authorization: request.headers.authorization,
					selectedHeader: typeof selectedHeader === 'string' ? selectedHeader : undefined,
				});
				enteredCall?.();
				await callGate;
				if (breakCalls) response.destroy();
				if (callResult !== undefined) return callResult;
				return {
					content: [
						{
							type: 'text',
							text: `${label}:${String(call.params.arguments?.value)}${call.params.name === 'fail' ? ` ${secretCanary} ${headerCanary}` : ''}`,
						},
					],
					structuredContent: {
						provider: label,
						value: call.params.arguments?.value,
						nested: { credential: secretCanary, header: headerCanary },
					},
					...(call.params.name === 'fail' ? { isError: true } : {}),
				};
			});
			const bridge: Transport = {
				start: async () => {
					Object.assign(transport, {
						onmessage: (
							message: import('@modelcontextprotocol/sdk/types.js').JSONRPCMessage,
							extra?: import('@modelcontextprotocol/sdk/types.js').MessageExtraInfo,
						): void => {
							if ('method' in message) protocolMessages.push(message.method);
							bridge.onmessage?.(message, extra);
						},
						onclose: bridge.onclose,
						onerror: bridge.onerror,
					});
					await transport.start();
				},
				send: async (message, options) => transport.send(message, options),
				close: async () => transport.close(),
			};
			await server.connect(bridge);
			try {
				await transport.handleRequest(request, response);
			} finally {
				await server.close();
				servers.delete(server);
			}
		};
		void handle().catch(() => {
			response.writeHead(500);
			response.end();
		});
	});
	http.listen(port, '127.0.0.1');
	await once(http, 'listening');
	const address = http.address();
	if (address === null || typeof address === 'string') throw new Error('Missing provider address');
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		listings,
		protocolMessages,
		httpMethods,
		get legacySseRequests() {
			return legacySseRequests;
		},
		effects,
		close: async () => {
			await Promise.all([...servers].map(async (server) => server.close()));
			http.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				http.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		},
		setDiscoveryFailure: (failed) => {
			discoveryFailed = failed;
		},
		setCallResult: (result) => {
			callResult = result;
		},
		breakCalls: () => {
			breakCalls = true;
		},
		duplicateDiscovery: () => {
			duplicates = true;
		},
		holdCalls: () => {
			let release: (() => void) | undefined;
			const entered = new Promise<void>((resolve) => {
				enteredCall = resolve;
			});
			callGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return {
				entered,
				release: () => {
					release?.();
					enteredCall = undefined;
				},
			};
		},
		holdDiscovery: () => {
			let release: (() => void) | undefined;
			const entered = new Promise<void>((resolve) => {
				enteredDiscovery = resolve;
			});
			discoveryGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return {
				entered,
				release: () => {
					release?.();
					enteredDiscovery = undefined;
				},
			};
		},
	};
}

export function fixtureConfig(
	directory: string,
	urls: readonly [string, string],
	exposure: 'compact' | 'catalog' = 'compact',
): NodeHostConfig {
	const policy = {
		backendKind: 'mcp_provider',
		tools: { allow: '*', deny: ['hidden', 'blocked'] },
		calls: {
			kind: 'selectors',
			withoutApproval: { allow: ['read', 'fail'], deny: [] },
			requiresApproval: { allow: ['ask'], deny: [] },
		},
		operations: {},
	};
	return nodeHostConfigSchema.parse({
		schemaVersion: 1,
		authority: 'test-tool-authority',
		revision,
		workspaceLayer: 'not-configured',
		storeDirectory: path.join(directory, 'store'),
		auth: {
			audience: 'tool-portal:mcp',
			serviceGeneration: 'generation-1',
			credentials: ['a', 'b'].map((agent) => ({
				bearerToken: `credential-${agent}`,
				credentialVersion: 1,
				principal: {
					agentId: `agent-${agent}`,
					profileAssignmentRevision: 'assignment-1',
					toolPortalProfileId: `profile-${agent}`,
				},
			})),
		},
		profiles: {
			'profile-a': { revision, profile: { profileId: 'profile-a', namespaces: { alpha: policy } } },
			'profile-b': { revision, profile: { profileId: 'profile-b', namespaces: { beta: policy } } },
		},
		mcp: {
			schemaVersion: 1,
			providers: Object.fromEntries(
				['alpha', 'beta'].map((namespace, index) => [
					namespace,
					{
						kind: 'mcp',
						namespace,
						transport: {
							kind: 'streamable-http',
							url: urls[index],
							headers: {
								Authorization: {
									source: 'environment',
									name: 'PROVIDER_SECRET',
									format: { kind: 'bearer' },
								},
								'x-selected-binding': { source: 'environment', name: 'HEADER_SECRET' },
							},
						},
					},
				]),
			),
		},
		listener: {
			kind: 'http',
			hostname: '127.0.0.1',
			port: 0,
			routePath: '/mcp',
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: ['https://allowed.example'],
		},
		exposure,
	});
}

export async function writeFixtureConfig(
	config: NodeHostConfig,
	directory: string,
): Promise<string> {
	const configPath = path.join(directory, 'host.jsonc');
	await writeFile(configPath, `// real host configuration\n${JSON.stringify(config)}`);
	return configPath;
}

export async function fixtureDirectory(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), '2026-10-tool-host-node-'));
}

export async function connectClient(
	endpoint: URL,
	token: string,
	brand = 'test-client',
): Promise<{ readonly client: Client; readonly transport: StreamableHTTPClientTransport }> {
	const client = new Client(
		{ name: brand, version: '1.0.0' },
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
	);
	const transport = new StreamableHTTPClientTransport(endpoint, {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	try {
		await client.connect(transport);
		return { client, transport };
	} catch (error) {
		await client.close();
		throw error;
	}
}

export function decodedResult(result: unknown): Record<string, unknown> {
	const parsed = z
		.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
		.parse(result);
	const core = z
		.object({
			structuredContent: z.record(z.string(), z.unknown()).optional(),
			auditEvents: z.array(z.unknown()).optional(),
			items: z
				.array(
					z.discriminatedUnion('status', [
						z.object({
							status: z.literal('success'),
							requestId: z.string(),
							structuredContent: z.unknown(),
						}),
						z.object({
							status: z.literal('failed'),
							requestId: z.string(),
							error: z.object({ code: z.string() }).passthrough(),
						}),
					]),
				)
				.optional(),
		})
		.parse(JSON.parse(parsed.content[0]?.text ?? 'null'));
	if (core.structuredContent !== undefined) return core.structuredContent;
	return {
		ok: !(core.items ?? []).some((item) => item.status === 'failed'),
		errors: [],
		diagnostics: core.auditEvents ?? [],
		results: Object.fromEntries(
			(core.items ?? []).map((item) => [
				item.requestId,
				item.status === 'success'
					? { ok: true, input: { id: item.requestId }, output: item.structuredContent }
					: {
							ok: false,
							input: { id: item.requestId },
							error: { ...item.error, kind: item.error.code },
						},
			]),
		),
	};
}

export function successfulOutput(result: unknown, item: string): Record<string, unknown> {
	const batch = decodedResult(result);
	return (
		z
			.object({
				results: z.record(
					z.string(),
					z.object({ ok: z.literal(true), output: z.record(z.string(), z.unknown()) }),
				),
			})
			.parse(batch).results[item]?.output ?? {}
	);
}

/** Current trusted context for store observations, without depending on its opaque encoding. */
export function fixtureContextRef(config: NodeHostConfig, agentId = 'agent-a'): string {
	const credential = compileNodeHostCredentialSet(config.auth).credentials.find(
		(entry) => entry.principal.agentId === agentId,
	);
	if (credential === undefined) throw new Error('Missing fixture credential');
	return credential.credentialId;
}
