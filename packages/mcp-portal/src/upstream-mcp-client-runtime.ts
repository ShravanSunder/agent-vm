import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	SSEClientTransport,
	type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
	StreamableHTTPClientTransport,
	type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { normalizeHeaders, type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

import type { JsonObject } from './json-schema.js';
import {
	isCredentialConfigKey,
	redactThrownError,
	redactUpstreamResponse,
} from './upstream-response-middleware.js';

export type UpstreamMcpTransportKind = 'auto-http' | 'sse' | 'stdio' | 'streamable-http';

interface BaseUpstreamMcpServer {
	readonly connectionTimeoutMs?: number;
	readonly namespace: string;
	readonly transport: UpstreamMcpTransportKind;
}

export interface RemoteUpstreamMcpServer extends BaseUpstreamMcpServer {
	readonly eventSourceInit?: SSEClientTransportOptions['eventSourceInit'];
	readonly headers?: Readonly<Record<string, string>>;
	readonly requestInit?: RequestInit;
	readonly transport: 'auto-http' | 'sse' | 'streamable-http';
	readonly url: string;
}

export interface StdioUpstreamMcpServer extends BaseUpstreamMcpServer {
	readonly args?: readonly string[];
	readonly command: string;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly transport: 'stdio';
}

export type NormalizedUpstreamMcpServer = RemoteUpstreamMcpServer | StdioUpstreamMcpServer;

export interface ListToolsCall {
	readonly bindingId: string;
	readonly namespace: string;
}

export interface UpstreamToolCall {
	readonly arguments: JsonObject;
	readonly bindingId: string;
	readonly namespace: string;
	readonly toolName: string;
}

export interface UpstreamListToolsResult {
	readonly nextCursor?: string | undefined;
	readonly tools: readonly Tool[];
}

export interface UpstreamMcpClientLike {
	readonly callTool: (params: {
		readonly arguments: JsonObject;
		readonly name: string;
	}) => Promise<unknown>;
	readonly close: () => Promise<void> | void;
	readonly connect: (transport: unknown) => Promise<void>;
	readonly listTools: (params?: { readonly cursor?: string }) => Promise<UpstreamListToolsResult>;
}

export interface UpstreamMcpRuntimeOptions {
	readonly additionalRedactionValues?: readonly string[];
	readonly createClient?: () => UpstreamMcpClientLike;
	readonly createTransport?: (
		server: NormalizedUpstreamMcpServer,
		transport: Exclude<UpstreamMcpTransportKind, 'auto-http'>,
	) => unknown;
	readonly servers: readonly NormalizedUpstreamMcpServer[];
}

export interface UpstreamMcpClientRuntime {
	readonly callTool: (call: UpstreamToolCall) => Promise<unknown>;
	readonly closeBinding: (bindingId: string) => Promise<void>;
	readonly closeSession: (scopeKey: string) => Promise<void>;
	readonly listTools: (call: ListToolsCall) => Promise<readonly Tool[]>;
}

interface CachedClient {
	readonly client: UpstreamMcpClientLike;
}

interface PendingClient {
	readonly generation: number;
	readonly promise: Promise<UpstreamMcpClientLike>;
}

const defaultConnectionTimeoutMs = 30_000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransport(value: unknown): value is Transport {
	return (
		isObjectRecord(value) &&
		typeof value.start === 'function' &&
		typeof value.send === 'function' &&
		typeof value.close === 'function'
	);
}

function createSdkClient(): UpstreamMcpClientLike {
	const client = new Client({ name: 'agent-vm-mcp-portal', version: '1.0.0' });

	return {
		callTool: async (params) => await client.callTool(params),
		close: async () => {
			await client.close();
		},
		connect: async (transport) => {
			if (!isTransport(transport)) {
				throw new Error('SDK MCP client requires a valid MCP transport.');
			}
			await client.connect(transport);
		},
		listTools: async (params) => {
			const result = await client.listTools(params);
			return {
				...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
				tools: result.tools,
			};
		},
	};
}

function withRemoteHeaders(server: RemoteUpstreamMcpServer): RemoteUpstreamMcpServer {
	if (!server.headers) {
		return server;
	}

	return {
		...server,
		requestInit: {
			...server.requestInit,
			headers: {
				...normalizeHeaders(server.requestInit?.headers),
				...server.headers,
			},
		},
	};
}

function createSdkTransport(
	server: NormalizedUpstreamMcpServer,
	transport: Exclude<UpstreamMcpTransportKind, 'auto-http'>,
): unknown {
	if (transport === 'stdio') {
		if (server.transport !== 'stdio') {
			throw new Error('Stdio transport requires stdio server config.');
		}

		return new StdioClientTransport({
			...(server.args ? { args: [...server.args] } : {}),
			command: server.command,
			...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
			...(server.env ? { env: { ...server.env } } : {}),
		});
	}

	if (server.transport === 'stdio') {
		throw new Error('Remote transport requires remote server config.');
	}

	const remoteServer = withRemoteHeaders(server);
	if (transport === 'sse') {
		const options: SSEClientTransportOptions = {};
		if (remoteServer.eventSourceInit !== undefined) {
			options.eventSourceInit = remoteServer.eventSourceInit;
		}
		if (remoteServer.requestInit !== undefined) {
			options.requestInit = remoteServer.requestInit;
		}
		return new SSEClientTransport(new URL(remoteServer.url), options);
	}

	const options: StreamableHTTPClientTransportOptions = {};
	if (remoteServer.requestInit !== undefined) {
		options.requestInit = remoteServer.requestInit;
	}
	return new StreamableHTTPClientTransport(new URL(remoteServer.url), options);
}

function cacheKey(bindingId: string, namespace: string): string {
	return `${bindingId}\n${namespace}`;
}

function rootBindingId(bindingId: string): string {
	return bindingId.split('\n', 1)[0] ?? bindingId;
}

function transportAttempts(
	server: NormalizedUpstreamMcpServer,
): readonly Exclude<UpstreamMcpTransportKind, 'auto-http'>[] {
	if (server.transport === 'auto-http') {
		return ['streamable-http', 'sse'];
	}

	return [server.transport];
}

function redactionValuesFromServer(server: NormalizedUpstreamMcpServer): readonly string[] {
	if (server.transport === 'stdio') {
		return Object.entries(server.env ?? {})
			.filter(([key, value]) => isCredentialConfigKey(key) && value.length > 0)
			.map(([, value]) => value);
	}

	return Object.entries(server.headers ?? {})
		.filter(([key, value]) => isCredentialConfigKey(key) && value.length > 0)
		.map(([, value]) => value);
}

function timeoutMsForServer(server: NormalizedUpstreamMcpServer): number {
	return server.connectionTimeoutMs ?? defaultConnectionTimeoutMs;
}

async function withTimeout<TResult>(
	promise: Promise<TResult>,
	props: {
		readonly operation: string;
		readonly timeoutMs: number;
	},
): Promise<TResult> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					reject(new Error(`${props.operation} timed out after ${props.timeoutMs}ms.`));
				}, props.timeoutMs);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

async function listAllTools(
	client: UpstreamMcpClientLike,
	cursor: string | undefined,
	collectedTools: readonly Tool[],
	timeoutMs: number,
): Promise<readonly Tool[]> {
	const result = await withTimeout(client.listTools(cursor ? { cursor } : undefined), {
		operation: 'MCP listTools',
		timeoutMs,
	});
	const nextTools = [...collectedTools, ...result.tools];
	return result.nextCursor
		? listAllTools(client, result.nextCursor, nextTools, timeoutMs)
		: nextTools;
}

async function closeClientAfterFailure(client: UpstreamMcpClientLike | null): Promise<void> {
	if (!client) {
		return;
	}
	try {
		await client.close();
	} catch {
		// Preserve the original upstream failure; close errors are best-effort cleanup.
	}
}

function redactToolCatalog(
	tools: readonly Tool[],
	options: { readonly exactValues: readonly string[] },
): readonly Tool[] {
	return tools.map((tool) => ToolSchema.parse(redactUpstreamResponse(tool, options)));
}

export function createUpstreamMcpClientRuntime(
	options: UpstreamMcpRuntimeOptions,
): UpstreamMcpClientRuntime {
	const serversByNamespace = new Map(options.servers.map((server) => [server.namespace, server]));
	const clients = new Map<string, CachedClient>();
	const pendingClients = new Map<string, PendingClient>();
	const bindingGenerations = new Map<string, number>();
	const createClient = options.createClient ?? createSdkClient;
	const createTransport = options.createTransport ?? createSdkTransport;
	const redactionValues = [
		...(options.additionalRedactionValues ?? []),
		...options.servers.flatMap((server) => redactionValuesFromServer(server)),
	];

	function generationForBinding(bindingId: string): number {
		return (
			bindingGenerations.get(bindingId) ?? bindingGenerations.get(rootBindingId(bindingId)) ?? 0
		);
	}

	function incrementBindingGeneration(bindingId: string): void {
		const rootBinding = rootBindingId(bindingId);
		bindingGenerations.set(rootBinding, (bindingGenerations.get(rootBinding) ?? 0) + 1);
	}

	function incrementScopeGeneration(scopeKey: string): void {
		bindingGenerations.set(scopeKey, (bindingGenerations.get(scopeKey) ?? 0) + 1);
	}

	async function createConnectedClient(
		server: NormalizedUpstreamMcpServer,
	): Promise<UpstreamMcpClientLike> {
		const attempts = transportAttempts(server);
		async function tryAttempt(
			attemptIndex: number,
			lastError: Error | null,
		): Promise<UpstreamMcpClientLike> {
			const transportKind = attempts[attemptIndex];
			if (transportKind === undefined) {
				throw (
					lastError ??
					new Error(`Could not connect to upstream MCP namespace "${server.namespace}".`)
				);
			}

			const client = createClient();
			const transportServer =
				transportKind === 'sse' && server.transport !== 'stdio'
					? withRemoteHeaders(server)
					: server;
			const transport = createTransport(transportServer, transportKind);
			try {
				await withTimeout(client.connect(transport), {
					operation: `MCP ${transportKind} connect for namespace "${server.namespace}"`,
					timeoutMs: timeoutMsForServer(server),
				});
				return client;
			} catch (error) {
				const redactedError = redactThrownError(error, { exactValues: redactionValues });
				await closeClientAfterFailure(client);
				return tryAttempt(attemptIndex + 1, redactedError);
			}
		}

		return tryAttempt(0, null);
	}

	async function getClient(bindingId: string, namespace: string): Promise<UpstreamMcpClientLike> {
		const key = cacheKey(bindingId, namespace);
		const cachedClient = clients.get(key);
		if (cachedClient) {
			return cachedClient.client;
		}
		const pendingClient = pendingClients.get(key);
		const generation = generationForBinding(bindingId);
		if (pendingClient && pendingClient.generation === generation) {
			return pendingClient.promise;
		}
		if (pendingClient) {
			pendingClients.delete(key);
			void pendingClient.promise.then(closeClientAfterFailure, () => undefined);
		}

		const server = serversByNamespace.get(namespace);
		if (!server) {
			throw new Error(`Unknown upstream MCP namespace "${namespace}".`);
		}

		const pending = createConnectedClient(server);
		const pendingRecord = { generation, promise: pending } satisfies PendingClient;
		pendingClients.set(key, pendingRecord);
		try {
			const client = await pending;
			if (generationForBinding(bindingId) !== generation) {
				await closeClientAfterFailure(client);
				throw new Error(`MCP client for binding "${rootBindingId(bindingId)}" was invalidated.`);
			}
			clients.set(key, { client });
			return client;
		} finally {
			if (pendingClients.get(key) === pendingRecord) {
				pendingClients.delete(key);
			}
		}
	}

	return {
		async callTool(call: UpstreamToolCall): Promise<unknown> {
			const key = cacheKey(call.bindingId, call.namespace);
			let client: UpstreamMcpClientLike | null = null;
			try {
				client = await getClient(call.bindingId, call.namespace);
				const server = serversByNamespace.get(call.namespace);
				return redactUpstreamResponse(
					await withTimeout(client.callTool({ arguments: call.arguments, name: call.toolName }), {
						operation: `MCP callTool ${call.namespace}.${call.toolName}`,
						timeoutMs: server ? timeoutMsForServer(server) : defaultConnectionTimeoutMs,
					}),
					{ exactValues: redactionValues },
				);
			} catch (error) {
				clients.delete(key);
				await closeClientAfterFailure(client);
				throw redactThrownError(error, { exactValues: redactionValues });
			}
		},
		async closeBinding(bindingId: string): Promise<void> {
			incrementBindingGeneration(bindingId);
			const closePromises: Promise<void>[] = [];
			for (const [key, cachedClient] of clients.entries()) {
				if (key !== bindingId && !key.startsWith(`${bindingId}\n`)) {
					continue;
				}
				clients.delete(key);
				closePromises.push(closeClientAfterFailure(cachedClient.client));
			}
			for (const [key, pendingClient] of pendingClients.entries()) {
				if (key !== bindingId && !key.startsWith(`${bindingId}\n`)) {
					continue;
				}
				pendingClients.delete(key);
				closePromises.push(pendingClient.promise.then(closeClientAfterFailure, () => undefined));
			}
			await Promise.all(closePromises);
		},
		async closeSession(scopeKey: string): Promise<void> {
			incrementScopeGeneration(scopeKey);
			const closePromises: Promise<void>[] = [];
			for (const [key, cachedClient] of clients.entries()) {
				if (key !== scopeKey && !key.startsWith(`${scopeKey}\n`)) {
					continue;
				}
				clients.delete(key);
				closePromises.push(closeClientAfterFailure(cachedClient.client));
			}
			for (const [key, pendingClient] of pendingClients.entries()) {
				if (key !== scopeKey && !key.startsWith(`${scopeKey}\n`)) {
					continue;
				}
				pendingClients.delete(key);
				closePromises.push(pendingClient.promise.then(closeClientAfterFailure, () => undefined));
			}
			await Promise.all(closePromises);
		},
		async listTools(call: ListToolsCall): Promise<readonly Tool[]> {
			const key = cacheKey(call.bindingId, call.namespace);
			let client: UpstreamMcpClientLike | null = null;
			try {
				client = await getClient(call.bindingId, call.namespace);
				const server = serversByNamespace.get(call.namespace);
				return redactToolCatalog(
					await listAllTools(
						client,
						undefined,
						[],
						server ? timeoutMsForServer(server) : defaultConnectionTimeoutMs,
					),
					{ exactValues: redactionValues },
				);
			} catch (error) {
				clients.delete(key);
				await closeClientAfterFailure(client);
				throw redactThrownError(error, { exactValues: redactionValues });
			}
		},
	};
}
