import { ToolSchema as GatewayToolSchema } from '@modelcontextprotocol/core';
import type { Tool } from '@modelcontextprotocol/server';

import type { NormalizedUpstreamMcpServer } from '#upstream-mcp-connectors/models/upstream-mcp-server';
import {
	createUpstreamMcpError,
	transportSummaryFromServer,
	isUpstreamMcpError,
	messageFromUnknownError,
} from '#upstream-mcp-connectors/upstream-mcp-errors';
import {
	type UpstreamMcpRuntimeOptions,
	type UpstreamMcpClientRuntime,
	type CachedClient,
	type PendingClient,
	type UpstreamMcpClientLike,
	createSdkClient,
	defaultMaxResponseBytes,
	redactionValuesFromServer,
	rootAgentScopeId,
	closeClientAfterFailure,
	type UpstreamMcpCloseErrorContext,
	closeClientForTeardown,
	transportAttempts,
	createRuntimeAbortSignal,
	withTimeout,
	timeoutMsForServer,
	safeFailureFromUnknown,
	elapsedMsSince,
	cacheKey,
	type UpstreamToolCall,
	defaultConnectionTimeoutMs,
	assertUpstreamResponseSize,
	isMcpToolErrorResult,
	providerErrorMessageFromMcpToolError,
	isCallerAbortError,
	closeErrorContextFromCacheKey,
	type ListToolsCall,
	redactToolCatalog,
	listAllTools,
} from '#upstream-mcp-connectors/upstream-mcp-protocol';
import {
	redactCredentialText,
	redactUpstreamResponse,
	redactThrownError,
} from '#upstream-mcp-connectors/upstream-response-middleware';

export function createUpstreamMcpClientRuntime(
	options: UpstreamMcpRuntimeOptions,
): UpstreamMcpClientRuntime {
	const serversByNamespace = new Map(options.servers.map((server) => [server.namespace, server]));
	const clients = new Map<string, CachedClient>();
	const pendingClients = new Map<string, PendingClient>();
	const agentScopeGenerations = new Map<string, number>();
	const closedClients = new WeakSet<UpstreamMcpClientLike>();
	const createClient = options.createClient ?? createSdkClient;
	const createTransport = options.createUpstreamMcpTransport;
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
			redactionValues,
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
			const transport = createTransport(
				{
					...server,
					requestInit: {
						...server.requestInit,
						headers: { ...normalizeRequestHeaders(server.requestInit?.headers), ...server.headers },
					},
				},
				transportKind,
			);
			const timeoutAbort = createRuntimeAbortSignal(undefined);
			const startedAt = Date.now();
			try {
				await withTimeout(client.connect(transport, { signal: timeoutAbort.signal }), {
					onTimeout: timeoutAbort.abortTimeout,
					operation: `MCP ${transportKind} connect for namespace "${server.namespace}"`,
					timeoutMs: timeoutMsForServer(server),
				});
				return client;
			} catch (error) {
				const safeFailure = safeFailureFromUnknown(error, redactionValues);
				await closeClientAfterFailureOnce(client);
				const structuredError = createUpstreamMcpError({
					attemptTransport: transportKind,
					causeMessage: safeFailure.causeMessage,
					elapsedMs: elapsedMsSince(startedAt),
					...(safeFailure.failureClass === undefined
						? {}
						: { failureClass: safeFailure.failureClass }),
					...(safeFailure.httpStatusCode === undefined
						? {}
						: { httpStatusCode: safeFailure.httpStatusCode }),
					namespace: server.namespace,
					operation: `MCP ${transportKind} connect for namespace "${server.namespace}"`,
					phase: 'connect',
					timeoutMs: timeoutMsForServer(server),
					transport: transportSummaryFromServer(server, transportKind),
				});
				return tryAttempt(attemptIndex + 1, structuredError);
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
			const startedAt = Date.now();
			try {
				client = await getClient(call.agentScopeId, call.namespace);
				const server = serversByNamespace.get(call.namespace);
				const timeoutAbort = createRuntimeAbortSignal(call.signal);
				try {
					const upstreamResult = await withTimeout(
						client.callTool(
							{ arguments: call.arguments, name: call.toolName },
							{
								onprogress: (progress) => {
									void call.onEvent?.({
										kind: 'progress',
										...(progress.message !== undefined
											? {
													message: redactCredentialText(progress.message, {
														exactValues: redactionValues,
													}),
												}
											: {}),
										progress: progress.progress,
										...(progress.total !== undefined ? { total: progress.total } : {}),
									});
								},
								signal: timeoutAbort.signal,
							},
						),
						{
							onTimeout: timeoutAbort.abortTimeout,
							operation: `MCP callTool ${call.namespace}.${call.toolName}`,
							timeoutMs: server ? timeoutMsForServer(server) : defaultConnectionTimeoutMs,
						},
					);
					assertUpstreamResponseSize(upstreamResult, maxResponseBytes);
					const redactedUpstreamResult = redactUpstreamResponse(upstreamResult, {
						exactValues: redactionValues,
					});
					if (isMcpToolErrorResult(redactedUpstreamResult)) {
						if (server === undefined) {
							throw new Error(`Unknown upstream MCP namespace "${call.namespace}".`);
						}
						const providerErrorMessage =
							providerErrorMessageFromMcpToolError(redactedUpstreamResult);
						throw createUpstreamMcpError({
							causeMessage: 'Remote MCP tool returned an error result.',
							elapsedMs: elapsedMsSince(startedAt),
							failureClass: 'tool_error',
							namespace: call.namespace,
							operation: `MCP callTool ${call.namespace}.${call.toolName}`,
							phase: 'call_tool',
							...(providerErrorMessage === undefined ? {} : { providerErrorMessage }),
							timeoutMs: timeoutMsForServer(server),
							toolName: call.toolName,
							transport: transportSummaryFromServer(server),
						});
					}
					return redactedUpstreamResult;
				} finally {
					timeoutAbort.dispose();
				}
			} catch (error) {
				if (isCallerAbortError(error, call.signal)) {
					throw redactThrownError(error, { exactValues: redactionValues });
				}
				clients.delete(key);
				await closeClientAfterFailureOnce(client);
				if (isUpstreamMcpError(error)) {
					throw error;
				}
				const safeFailure = safeFailureFromUnknown(error, redactionValues);
				const server = serversByNamespace.get(call.namespace);
				if (server !== undefined) {
					throw createUpstreamMcpError({
						causeMessage: safeFailure.causeMessage,
						elapsedMs: elapsedMsSince(startedAt),
						...(safeFailure.failureClass === undefined
							? {}
							: { failureClass: safeFailure.failureClass }),
						...(safeFailure.httpStatusCode === undefined
							? {}
							: { httpStatusCode: safeFailure.httpStatusCode }),
						namespace: call.namespace,
						operation: `MCP callTool ${call.namespace}.${call.toolName}`,
						phase: 'call_tool',
						timeoutMs: timeoutMsForServer(server),
						toolName: call.toolName,
						transport: transportSummaryFromServer(server),
					});
				}
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
			const startedAt = Date.now();
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
					).map((tool) => GatewayToolSchema.parse(tool));
				} finally {
					timeoutAbort.dispose();
				}
			} catch (error) {
				clients.delete(key);
				await closeClientAfterFailureOnce(client);
				if (isUpstreamMcpError(error)) {
					throw error;
				}
				const redactedError = redactThrownError(error, { exactValues: redactionValues });
				const server = serversByNamespace.get(call.namespace);
				if (server !== undefined) {
					throw createUpstreamMcpError({
						causeMessage: messageFromUnknownError(redactedError),
						elapsedMs: elapsedMsSince(startedAt),
						namespace: call.namespace,
						operation: 'MCP listTools',
						phase: 'list_tools',
						timeoutMs: timeoutMsForServer(server),
						transport: transportSummaryFromServer(server),
					});
				}
				throw redactedError;
			}
		},
	};
}

/** Preserve the existing Headers, tuple-list and record forms at the host-neutral boundary. */
function normalizeRequestHeaders(
	headers: RequestInit['headers'],
): Record<string, string | undefined> {
	if (headers === undefined) return {};
	if (headers instanceof Headers) return Object.fromEntries(headers.entries());
	if (Array.isArray(headers)) return Object.fromEntries(headers);
	return { ...headers };
}
