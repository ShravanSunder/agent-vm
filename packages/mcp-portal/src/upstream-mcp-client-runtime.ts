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
import { ToolSchema, type Progress, type Tool } from '@modelcontextprotocol/sdk/types.js';

import type { JsonObject } from './json-schema.js';
import {
	redactThrownError,
	redactUpstreamCatalogValue,
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
	readonly agentScopeId: string;
	readonly namespace: string;
}

export interface UpstreamToolCall {
	readonly arguments: JsonObject;
	readonly agentScopeId: string;
	readonly namespace: string;
	readonly onEvent?: (event: UpstreamToolEvent) => Promise<void> | void;
	readonly requestId?: string;
	readonly signal?: AbortSignal;
	readonly toolName: string;
}

export type UpstreamToolEvent =
	| {
			readonly kind: 'progress';
			readonly message?: string;
			readonly progress: number;
			readonly total?: number;
	  }
	// Extension event for runtimes that can source request-correlated MCP notifications.
	// The stock SDK callTool bridge currently emits real progress via RequestOptions.onprogress.
	| {
			readonly kind: 'upstream_notification';
			readonly method: string;
			readonly params: unknown;
	  }
	// Extension event for runtimes that can source incremental content before the final result.
	| {
			readonly content:
				| { readonly text: string; readonly type: 'text' }
				| { readonly type: 'json'; readonly value: unknown };
			readonly kind: 'partial_content';
	  };

export type UpstreamMcpProgress = Progress;

export interface UpstreamListToolsResult {
	readonly nextCursor?: string | undefined;
	readonly tools: readonly Tool[];
}

export interface UpstreamMcpClientLike {
	readonly callTool: (
		params: {
			readonly arguments: JsonObject;
			readonly name: string;
		},
		resultSchema?: unknown,
		options?: {
			readonly onprogress?: (progress: UpstreamMcpProgress) => void;
			readonly signal?: AbortSignal;
		},
	) => Promise<unknown>;
	readonly close: () => Promise<void> | void;
	readonly connect: (
		transport: unknown,
		options?: { readonly signal?: AbortSignal },
	) => Promise<void>;
	readonly listTools: (
		params?: { readonly cursor?: string },
		options?: { readonly signal?: AbortSignal },
	) => Promise<UpstreamListToolsResult>;
}

export interface UpstreamMcpRuntimeOptions {
	readonly additionalRedactionValues?: readonly string[];
	readonly createClient?: () => UpstreamMcpClientLike;
	readonly createTransport?: (
		server: NormalizedUpstreamMcpServer,
		transport: Exclude<UpstreamMcpTransportKind, 'auto-http'>,
	) => unknown;
	readonly maxResponseBytes?: number;
	readonly onCloseError?: (error: Error, context: UpstreamMcpCloseErrorContext) => void;
	readonly servers: readonly NormalizedUpstreamMcpServer[];
}

export interface UpstreamMcpCloseErrorContext {
	readonly agentScopeId: string;
	readonly namespace?: string;
}

export interface UpstreamMcpClientRuntime {
	readonly callTool: (call: UpstreamToolCall) => Promise<unknown>;
	readonly closeAgentScope: (agentScopeId: string) => Promise<void>;
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
const defaultMaxResponseBytes = 4 * 1_024 * 1_024;

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
	const client = new Client({ name: 'mcp-portal', version: '1.0.0' });
	return {
		callTool: async (params, _resultSchema, options) =>
			await client.callTool(params, undefined, options),
		close: async () => {
			await client.close();
		},
		connect: async (transport, options) => {
			if (!isTransport(transport)) {
				throw new Error('SDK MCP client requires a valid MCP transport.');
			}
			await client.connect(transport, options);
		},
		listTools: async (params, options) => {
			const result = await client.listTools(params, options);
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

function cacheKey(agentScopeId: string, namespace: string): string {
	return `${agentScopeId}\n${namespace}`;
}

function rootAgentScopeId(agentScopeId: string): string {
	return agentScopeId.split('\n', 1)[0] ?? agentScopeId;
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
		return Object.values(server.env ?? {}).filter((value) => value.length > 0);
	}

	return Object.values(server.headers ?? {}).filter((value) => value.length > 0);
}

function timeoutMsForServer(server: NormalizedUpstreamMcpServer): number {
	return server.connectionTimeoutMs ?? defaultConnectionTimeoutMs;
}

function assertUpstreamResponseSize(value: unknown, maxResponseBytes: number): void {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		return;
	}
	const byteLength = Buffer.byteLength(serialized, 'utf8');
	if (byteLength > maxResponseBytes) {
		throw new Error(
			`MCP upstream response exceeded ${String(maxResponseBytes)} bytes (${String(byteLength)} bytes).`,
		);
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function isCallerAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true && (error === signal.reason || isAbortError(error));
}

async function withTimeout<TResult>(
	promise: Promise<TResult>,
	props: {
		readonly onTimeout?: (error: Error) => void;
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
					const error = new Error(`${props.operation} timed out after ${props.timeoutMs}ms.`);
					props.onTimeout?.(error);
					reject(error);
				}, props.timeoutMs);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function createRuntimeAbortSignal(parentSignal: AbortSignal | undefined): {
	readonly abortTimeout: (error: Error) => void;
	readonly dispose: () => void;
	readonly signal: AbortSignal;
} {
	const controller = new AbortController();
	const abortFromParent = (): void => {
		if (!controller.signal.aborted) {
			controller.abort(parentSignal?.reason);
		}
	};
	if (parentSignal?.aborted) {
		abortFromParent();
	} else {
		parentSignal?.addEventListener('abort', abortFromParent, { once: true });
	}

	return {
		abortTimeout: (error) => {
			if (!controller.signal.aborted) {
				controller.abort(error);
			}
		},
		dispose: () => {
			parentSignal?.removeEventListener('abort', abortFromParent);
		},
		signal: controller.signal,
	};
}

async function listAllTools(
	client: UpstreamMcpClientLike,
	cursor: string | undefined,
	collectedTools: readonly Tool[],
	timeoutAbort: {
		readonly abortTimeout: (error: Error) => void;
		readonly signal: AbortSignal;
	},
	timeoutMs: number,
): Promise<readonly Tool[]> {
	const result = await withTimeout(
		client.listTools(cursor ? { cursor } : undefined, { signal: timeoutAbort.signal }),
		{
			onTimeout: timeoutAbort.abortTimeout,
			operation: 'MCP listTools',
			timeoutMs,
		},
	);
	const nextTools = [...collectedTools, ...result.tools];
	return result.nextCursor
		? listAllTools(client, result.nextCursor, nextTools, timeoutAbort, timeoutMs)
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

async function closeClientForTeardown(
	client: UpstreamMcpClientLike | null,
	props: {
		readonly context: UpstreamMcpCloseErrorContext;
		readonly onCloseError?:
			| ((error: Error, context: UpstreamMcpCloseErrorContext) => void)
			| undefined;
	},
): Promise<void> {
	if (!client) {
		return;
	}
	try {
		await client.close();
	} catch (error) {
		props.onCloseError?.(redactThrownError(error), props.context);
	}
}

function closeErrorContextFromCacheKey(cacheKeyValue: string): UpstreamMcpCloseErrorContext {
	const keyParts = cacheKeyValue.split('\n');
	const namespace = keyParts.length > 1 ? keyParts[keyParts.length - 1] : undefined;
	const agentScopeId =
		namespace !== undefined ? keyParts.slice(0, keyParts.length - 1).join('\n') : cacheKeyValue;
	return {
		agentScopeId,
		...(namespace !== undefined ? { namespace } : {}),
	};
}

function redactToolCatalog(
	tools: readonly Tool[],
	options: { readonly exactValues: readonly string[] },
): readonly Tool[] {
	return tools.map((tool) => ToolSchema.parse(redactUpstreamCatalogValue(tool, options)));
}

export function createUpstreamMcpClientRuntime(
	options: UpstreamMcpRuntimeOptions,
): UpstreamMcpClientRuntime {
	const serversByNamespace = new Map(options.servers.map((server) => [server.namespace, server]));
	const clients = new Map<string, CachedClient>();
	const pendingClients = new Map<string, PendingClient>();
	const agentScopeGenerations = new Map<string, number>();
	const closedClients = new WeakSet<UpstreamMcpClientLike>();
	const createClient = options.createClient ?? createSdkClient;
	const createTransport = options.createTransport ?? createSdkTransport;
	const maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
	const redactionValues = [
		...(options.additionalRedactionValues ?? []),
		...options.servers.flatMap((server) => redactionValuesFromServer(server)),
	];

	function generationForAgentScope(agentScopeId: string): number {
		return (
			agentScopeGenerations.get(agentScopeId) ??
			agentScopeGenerations.get(rootAgentScopeId(agentScopeId)) ??
			0
		);
	}

	function incrementAgentScopeGeneration(agentScopeId: string): void {
		const rootAgentScope = rootAgentScopeId(agentScopeId);
		agentScopeGenerations.set(rootAgentScope, (agentScopeGenerations.get(rootAgentScope) ?? 0) + 1);
	}

	function incrementScopeGeneration(scopeKey: string): void {
		agentScopeGenerations.set(scopeKey, (agentScopeGenerations.get(scopeKey) ?? 0) + 1);
	}

	async function closeClientAfterFailureOnce(client: UpstreamMcpClientLike | null): Promise<void> {
		if (!client || closedClients.has(client)) {
			return;
		}
		closedClients.add(client);
		await closeClientAfterFailure(client);
	}

	async function closeClientForTeardownOnce(
		client: UpstreamMcpClientLike | null,
		context: UpstreamMcpCloseErrorContext,
	): Promise<void> {
		if (!client || closedClients.has(client)) {
			return;
		}
		closedClients.add(client);
		await closeClientForTeardown(client, {
			context,
			onCloseError: options.onCloseError,
		});
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
			const timeoutAbort = createRuntimeAbortSignal(undefined);
			try {
				await withTimeout(client.connect(transport, { signal: timeoutAbort.signal }), {
					onTimeout: timeoutAbort.abortTimeout,
					operation: `MCP ${transportKind} connect for namespace "${server.namespace}"`,
					timeoutMs: timeoutMsForServer(server),
				});
				return client;
			} catch (error) {
				const redactedError = redactThrownError(error, { exactValues: redactionValues });
				await closeClientAfterFailureOnce(client);
				return tryAttempt(attemptIndex + 1, redactedError);
			} finally {
				timeoutAbort.dispose();
			}
		}

		return tryAttempt(0, null);
	}

	async function getClient(
		agentScopeId: string,
		namespace: string,
	): Promise<UpstreamMcpClientLike> {
		const key = cacheKey(agentScopeId, namespace);
		const cachedClient = clients.get(key);
		if (cachedClient) {
			return cachedClient.client;
		}
		const pendingClient = pendingClients.get(key);
		const generation = generationForAgentScope(agentScopeId);
		if (pendingClient && pendingClient.generation === generation) {
			return pendingClient.promise;
		}
		if (pendingClient) {
			pendingClients.delete(key);
			void pendingClient.promise.then(closeClientAfterFailureOnce, () => undefined);
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
			if (generationForAgentScope(agentScopeId) !== generation) {
				await closeClientAfterFailureOnce(client);
				throw new Error(
					`MCP client for agent scope "${rootAgentScopeId(agentScopeId)}" was invalidated.`,
				);
			}
			clients.set(key, { client });
			if (generationForAgentScope(agentScopeId) !== generation) {
				if (clients.get(key)?.client === client) {
					clients.delete(key);
				}
				await closeClientAfterFailureOnce(client);
				throw new Error(
					`MCP client for agent scope "${rootAgentScopeId(agentScopeId)}" was invalidated.`,
				);
			}
			return client;
		} finally {
			if (pendingClients.get(key) === pendingRecord) {
				pendingClients.delete(key);
			}
		}
	}

	return {
		async callTool(call: UpstreamToolCall): Promise<unknown> {
			const key = cacheKey(call.agentScopeId, call.namespace);
			let client: UpstreamMcpClientLike | null = null;
			try {
				client = await getClient(call.agentScopeId, call.namespace);
				const server = serversByNamespace.get(call.namespace);
				const timeoutAbort = createRuntimeAbortSignal(call.signal);
				try {
					const upstreamResult = await withTimeout(
						client.callTool({ arguments: call.arguments, name: call.toolName }, undefined, {
							onprogress: (progress) => {
								void call.onEvent?.({
									kind: 'progress',
									...(progress.message !== undefined ? { message: progress.message } : {}),
									progress: progress.progress,
									...(progress.total !== undefined ? { total: progress.total } : {}),
								});
							},
							signal: timeoutAbort.signal,
						}),
						{
							onTimeout: timeoutAbort.abortTimeout,
							operation: `MCP callTool ${call.namespace}.${call.toolName}`,
							timeoutMs: server ? timeoutMsForServer(server) : defaultConnectionTimeoutMs,
						},
					);
					assertUpstreamResponseSize(upstreamResult, maxResponseBytes);
					return redactUpstreamResponse(upstreamResult, { exactValues: redactionValues });
				} finally {
					timeoutAbort.dispose();
				}
			} catch (error) {
				if (isCallerAbortError(error, call.signal)) {
					throw redactThrownError(error, { exactValues: redactionValues });
				}
				clients.delete(key);
				await closeClientAfterFailureOnce(client);
				throw redactThrownError(error, { exactValues: redactionValues });
			}
		},
		async closeAgentScope(agentScopeId: string): Promise<void> {
			incrementAgentScopeGeneration(agentScopeId);
			const closePromises: Promise<void>[] = [];
			for (const [key, cachedClient] of clients.entries()) {
				if (key !== agentScopeId && !key.startsWith(`${agentScopeId}\n`)) {
					continue;
				}
				clients.delete(key);
				closePromises.push(
					closeClientForTeardownOnce(cachedClient.client, closeErrorContextFromCacheKey(key)),
				);
			}
			for (const [key, pendingClient] of pendingClients.entries()) {
				if (key !== agentScopeId && !key.startsWith(`${agentScopeId}\n`)) {
					continue;
				}
				pendingClients.delete(key);
				closePromises.push(
					pendingClient.promise.then(
						(client) => closeClientForTeardownOnce(client, closeErrorContextFromCacheKey(key)),
						() => undefined,
					),
				);
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
				closePromises.push(
					closeClientForTeardownOnce(cachedClient.client, closeErrorContextFromCacheKey(key)),
				);
			}
			for (const [key, pendingClient] of pendingClients.entries()) {
				if (key !== scopeKey && !key.startsWith(`${scopeKey}\n`)) {
					continue;
				}
				pendingClients.delete(key);
				closePromises.push(
					pendingClient.promise.then(
						(client) => closeClientForTeardownOnce(client, closeErrorContextFromCacheKey(key)),
						() => undefined,
					),
				);
			}
			await Promise.all(closePromises);
		},
		async listTools(call: ListToolsCall): Promise<readonly Tool[]> {
			const key = cacheKey(call.agentScopeId, call.namespace);
			let client: UpstreamMcpClientLike | null = null;
			try {
				client = await getClient(call.agentScopeId, call.namespace);
				const server = serversByNamespace.get(call.namespace);
				const timeoutAbort = createRuntimeAbortSignal(undefined);
				try {
					return redactToolCatalog(
						await listAllTools(
							client,
							undefined,
							[],
							timeoutAbort,
							server ? timeoutMsForServer(server) : defaultConnectionTimeoutMs,
						),
						{ exactValues: redactionValues },
					);
				} finally {
					timeoutAbort.dispose();
				}
			} catch (error) {
				clients.delete(key);
				await closeClientAfterFailureOnce(client);
				throw redactThrownError(error, { exactValues: redactionValues });
			}
		},
	};
}
