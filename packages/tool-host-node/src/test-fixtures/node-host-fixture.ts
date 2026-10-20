import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
	nodeHostConfigSchema,
	type NodeHostConfig,
} from '#node-host/configuration/node-host-config';

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
	readonly effects: {
		readonly name: string;
		readonly arguments: unknown;
		readonly authorization: string | undefined;
		readonly selectedHeader: string | undefined;
	}[];
	readonly close: () => Promise<void>;
	readonly duplicateDiscovery: () => void;
	readonly holdCalls: () => { readonly entered: Promise<void>; readonly release: () => void };
	readonly holdDiscovery: () => { readonly entered: Promise<void>; readonly release: () => void };
}

export async function startControlledProvider(
	label: string,
	providerOutput: { readonly resultText?: string } = {},
): Promise<ControlledProvider> {
	const effects: ControlledProvider['effects'] = [];
	const servers = new Set<Server>();
	let duplicates = false;
	let enteredCall: (() => void) | undefined;
	let callGate: Promise<void> = Promise.resolve();
	let enteredDiscovery: (() => void) | undefined;
	let discoveryGate: Promise<void> = Promise.resolve();
	const http = createServer((request, response) => {
		const handle = async (): Promise<void> => {
			const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
			const server = new Server(
				{ name: `provider-${label}`, version: '1.0.0' },
				{ capabilities: { tools: {} } },
			);
			servers.add(server);
			server.setRequestHandler(ListToolsRequestSchema, async () => {
				enteredDiscovery?.();
				await discoveryGate;
				return {
					tools: (duplicates ? ['read', 'read'] : ['read', 'ask', 'blocked', 'hidden', 'fail']).map(
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
				return {
					content: [
						{
							type: 'text',
							text: providerOutput.resultText ?? `${label}:${String(call.params.arguments?.value)}`,
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
						onmessage: bridge.onmessage,
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
	http.listen(0, '127.0.0.1');
	await once(http, 'listening');
	const address = http.address();
	if (address === null || typeof address === 'string') throw new Error('Missing provider address');
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		effects,
		close: async () => {
			await Promise.all([...servers].map(async (server) => server.close()));
			http.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				http.close((error) => (error === undefined ? resolve() : reject(error))),
			);
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
		// Explicit fixture-only values; these are not production sizing decisions.
		operationStoreBounds: {
			maximumOperations: 32,
			maximumRecordBytes: 4 * 1024 * 1024 + 32 * 1024,
		},
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

function isSdkTransport(value: unknown): value is Transport {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'send' in value &&
		typeof value.send === 'function' &&
		'close' in value &&
		typeof value.close === 'function'
	);
}

export async function connectClient(
	endpoint: URL,
	token: string,
	brand = 'test-client',
): Promise<{ readonly client: Client; readonly transport: StreamableHTTPClientTransport }> {
	const client = new Client({ name: brand, version: '1.0.0' });
	const transport = new StreamableHTTPClientTransport(endpoint, {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	// SDK 1.29.0's exact-optional sessionId declaration differs from Transport's.
	// Narrow the real instance through the same runtime transport check used by connectors.

	const candidate: unknown = transport;
	if (!isSdkTransport(candidate)) throw new Error('Invalid client transport');
	try {
		await client.connect(candidate);
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
	return z.record(z.string(), z.unknown()).parse(JSON.parse(parsed.content[0]?.text ?? 'null'));
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
