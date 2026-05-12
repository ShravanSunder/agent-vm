import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
	createPortalHttpApp,
	createPortalSessionManager,
	createUpstreamMcpClientRuntime,
	jsonObjectSchema,
	type JsonObject,
	type PortalApprovalCall,
	type PortalBindingIdentity,
	type PortalHttpBinding,
	type PortalSession,
	type PortalToolRecord,
} from '@agent-vm/mcp-portal';

import { normalizeOpenClawMcpServers } from './openclaw-mcp-server-config.js';
import type {
	OpenClawBeforeToolCallEvent,
	OpenClawBeforeToolCallResult,
	OpenClawPluginHookContext,
	OpenClawPortalPluginApi,
	OpenClawPromptHookContext,
} from './openclaw-plugin-api.js';
import { resolvePortalAgents } from './portal-agent-registry.js';
import {
	hashPortalApprovalCalls,
	InMemoryPortalApprovalBridge,
	type NormalizedPortalApprovalCall,
	normalizePortalApprovalArguments,
	type PortalApprovalGrantKey,
	type PortalPersistentApprovalKey,
} from './portal-approval-bridge.js';
import { resolvePortalApprovalDecision } from './portal-approval-policy.js';
import { PortalConfigWatcher } from './portal-config-watcher.js';
import { parsePortalConfig, type PortalConfig } from './portal-config.js';
import { createPortalPromptContext } from './portal-prompt-context.js';
import {
	createPortalBindingSecret,
	createPortalBindingsForAgents,
	createPortalServerName,
	materializedPortalToolNames,
	type PortalBindingRecord,
} from './portal-server-manager.js';

interface PortalPluginEntry {
	readonly description: string;
	readonly id: string;
	readonly name: string;
	readonly register: (api: OpenClawPortalPluginApi) => void;
}

interface PortalRuntimeBundle {
	readonly app: ReturnType<typeof createPortalHttpApp>;
	readonly bindings: readonly PortalBindingRecord[];
	readonly close: () => Promise<void>;
	readonly callToolNames: ReadonlyMap<string, PortalBindingIdentity>;
	readonly getPromptContext: (identity: PortalBindingIdentity) => Promise<string>;
	readonly maybeRequireApproval: (
		event: OpenClawBeforeToolCallEvent,
		context: OpenClawPluginHookContext,
	) => Promise<OpenClawBeforeToolCallResult | undefined>;
}

interface PortalRuntimeReloader {
	readonly close: () => Promise<void>;
	readonly get: () => Promise<PortalRuntimeBundle>;
}

interface ResolvedPortalHookIdentity {
	readonly ephemeral: boolean;
	readonly identity: PortalBindingIdentity;
}

interface PortalApprovalRequest {
	readonly arguments: JsonObject;
	readonly id: string;
	readonly namespace: string;
	readonly toolName: string;
}

const pluginId = 'mcp-portal';
const defaultGatewayBaseUrl = 'http://127.0.0.1:18789';
const ephemeralHookSessionIdPrefix = 'mcp-portal-hook-';
const portalSecretHeader = 'x-mcp-portal-binding-secret';

function hasFunction(value: unknown): value is (...args: readonly unknown[]) => unknown {
	return typeof value === 'function';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getObjectProperty(value: unknown, property: string): unknown {
	return isObjectRecord(value) ? value[property] : undefined;
}

function getPluginConfig(config: unknown): unknown {
	return getObjectProperty(
		getObjectProperty(getObjectProperty(config, 'plugins'), 'entries'),
		pluginId,
	);
}

function getPortalConfig(config: unknown, pluginConfig: unknown): PortalConfig {
	if (isObjectRecord(pluginConfig)) {
		return parsePortalConfig(pluginConfig);
	}
	const pluginEntry = getPluginConfig(config);
	const portalConfig = getObjectProperty(pluginEntry, 'config');
	return parsePortalConfig(isObjectRecord(portalConfig) ? portalConfig : {});
}

function getMcpServersConfig(config: unknown): unknown {
	return getObjectProperty(getObjectProperty(config, 'mcp'), 'servers');
}

function getExistingBindingSecret(config: unknown, agentId: string): string | undefined {
	const serverName = createPortalServerName(agentId);
	const serverConfig = getObjectProperty(getMcpServersConfig(config), serverName);
	const headers = getObjectProperty(serverConfig, 'headers');
	const configuredSecret = getObjectProperty(headers, portalSecretHeader);
	return typeof configuredSecret === 'string' && configuredSecret.length > 0
		? configuredSecret
		: undefined;
}

function getGatewayBaseUrl(config: unknown): string {
	const gateway = getObjectProperty(config, 'gateway');
	const port = getObjectProperty(gateway, 'port');
	return typeof port === 'number' && Number.isInteger(port) && port > 0
		? `http://127.0.0.1:${port}`
		: defaultGatewayBaseUrl;
}

function isPortalServerName(serverName: string): boolean {
	return serverName.startsWith('mcp_portal_');
}

function headersFromIncomingMessage(request: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				headers.append(key, entry);
			}
		} else if (value !== undefined) {
			headers.set(key, value);
		}
	}
	return headers;
}

function requestBodyStreamFromIncomingMessage(
	request: IncomingMessage,
	abortController: AbortController,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const cleanup = (): void => {
				request.off('aborted', handleAborted);
				request.off('close', handleClose);
				request.off('data', handleData);
				request.off('end', handleEnd);
				request.off('error', handleError);
			};
			const handleAborted = (): void => {
				cleanup();
				const error = new Error('Incoming MCP Portal request was aborted.');
				abortController.abort(error);
				controller.error(error);
			};
			const handleData = (chunk: Buffer | string): void => {
				controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			};
			const handleEnd = (): void => {
				cleanup();
				controller.close();
			};
			const handleError = (error: Error): void => {
				cleanup();
				abortController.abort(error);
				controller.error(error);
			};
			const handleClose = (): void => {
				if (request.complete) {
					return;
				}
				cleanup();
				const error = new Error('Incoming MCP Portal request closed before completion.');
				abortController.abort(error);
				controller.error(error);
			};

			request.on('aborted', handleAborted);
			request.on('close', handleClose);
			request.on('data', handleData);
			request.on('end', handleEnd);
			request.on('error', handleError);
		},
		cancel() {
			request.destroy();
		},
	});
}

export function createRequestFromIncomingMessage(request: IncomingMessage): Request {
	const headers = headersFromIncomingMessage(request);
	const host = headers.get('host') ?? '127.0.0.1';
	const method = request.method ?? 'GET';
	const bodyAllowed = method !== 'GET' && method !== 'HEAD';
	const abortController = new AbortController();
	const requestInit = {
		headers,
		method,
		signal: abortController.signal,
		...(bodyAllowed
			? {
					body: requestBodyStreamFromIncomingMessage(request, abortController),
					duplex: 'half',
				}
			: {}),
	} satisfies RequestInit & { readonly duplex?: 'half' };

	return new Request(`http://${host}${request.url ?? '/'}`, requestInit);
}

function createResponseDrainWait(serverResponse: ServerResponse): {
	readonly cancel: () => void;
	readonly promise: Promise<void>;
} {
	let settled = false;
	let cleanup = (): void => {
		settled = true;
	};
	const promise = new Promise<void>((resolve, reject) => {
		cleanup = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			serverResponse.off('close', handleClose);
			serverResponse.off('drain', handleDrain);
			serverResponse.off('error', handleError);
		};
		const handleClose = (): void => {
			cleanup();
			reject(new Error('Server response closed before drain.'));
		};
		const handleDrain = (): void => {
			cleanup();
			resolve();
		};
		const handleError = (error: Error): void => {
			cleanup();
			reject(error);
		};

		serverResponse.once('close', handleClose);
		serverResponse.once('drain', handleDrain);
		serverResponse.once('error', handleError);

		if (serverResponse.destroyed || serverResponse.writableEnded) {
			handleClose();
		}
	});

	return {
		cancel: () => {
			if (!settled) {
				cleanup();
			}
		},
		promise,
	};
}

async function writeChunkToServerResponse(
	serverResponse: ServerResponse,
	value: Uint8Array,
): Promise<void> {
	const waitForDrain = createResponseDrainWait(serverResponse);
	if (serverResponse.write(Buffer.from(value))) {
		void waitForDrain.promise.catch(() => undefined);
		waitForDrain.cancel();
		return;
	}
	await waitForDrain.promise;
}

async function writeReadableStreamToServerResponse(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	serverResponse: ServerResponse,
	closePromise: Promise<never>,
): Promise<void> {
	const result = await Promise.race([reader.read(), closePromise]);
	if (result.done) {
		return;
	}
	await writeChunkToServerResponse(serverResponse, result.value);
	await writeReadableStreamToServerResponse(reader, serverResponse, closePromise);
}

function createResponseCloseMonitor(serverResponse: ServerResponse): {
	readonly cleanup: () => void;
	readonly promise: Promise<never>;
} {
	let settled = false;
	let cleanup = (): void => {
		settled = true;
	};
	const promise = new Promise<never>((_resolve, reject) => {
		cleanup = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			serverResponse.off('close', handleClose);
			serverResponse.off('error', handleError);
		};
		const handleClose = (): void => {
			cleanup();
			reject(new Error('Server response closed while streaming MCP Portal response.'));
		};
		const handleError = (error: Error): void => {
			cleanup();
			reject(error);
		};

		serverResponse.once('close', handleClose);
		serverResponse.once('error', handleError);
		if (serverResponse.destroyed) {
			handleClose();
		}
	});

	return { cleanup, promise };
}

export async function writeFetchResponseToServerResponse(
	response: Response,
	serverResponse: ServerResponse,
): Promise<boolean> {
	serverResponse.statusCode = response.status;
	response.headers.forEach((value, key) => {
		serverResponse.setHeader(key, value);
	});

	if (!response.body) {
		serverResponse.end();
		return true;
	}

	const responseBody = response.body;
	const reader = responseBody.getReader();
	const closeMonitor = createResponseCloseMonitor(serverResponse);
	try {
		await writeReadableStreamToServerResponse(reader, serverResponse, closeMonitor.promise);
		closeMonitor.cleanup();
		serverResponse.end();
	} catch (error) {
		closeMonitor.cleanup();
		try {
			await reader.cancel(error);
		} catch {
			// The original stream/response error is more useful than a cancellation failure.
		}
		serverResponse.destroy(error instanceof Error ? error : new Error(String(error)));
		throw error;
	} finally {
		closeMonitor.cleanup();
		reader.releaseLock();
	}
	return true;
}

function createApprovalKey(props: {
	readonly approvalNonce: string;
	readonly bindingId: string;
	readonly calls: readonly NormalizedPortalApprovalCall[];
}): PortalApprovalGrantKey {
	return {
		approvalNonce: props.approvalNonce,
		bindingId: props.bindingId,
		callsHash: hashPortalApprovalCalls(props.calls),
	};
}

function createPersistentApprovalKey(props: {
	readonly calls: readonly NormalizedPortalApprovalCall[];
	readonly identity: PortalBindingIdentity;
}): PortalPersistentApprovalKey {
	const sessionId =
		props.identity.sessionId !== undefined && !isEphemeralHookIdentity(props.identity)
			? props.identity.sessionId
			: undefined;
	return {
		bindingId: props.identity.bindingId,
		callsHash: hashPortalApprovalCalls(props.calls),
		...(sessionId !== undefined ? { sessionId } : {}),
	};
}

function findTool(
	session: PortalSession,
	namespace: string,
	toolName: string,
): PortalToolRecord | null {
	return (
		session.catalog.tools.find(
			(tool) => tool.namespace === namespace && tool.toolName === toolName,
		) ?? null
	);
}

function createApprovalNonce(): string {
	return randomBytes(32).toString('base64url');
}

function createEphemeralHookSessionId(): string {
	return `${ephemeralHookSessionIdPrefix}${randomBytes(16).toString('base64url')}`;
}

function isEphemeralHookIdentity(identity: PortalBindingIdentity): boolean {
	return identity.sessionId?.startsWith(ephemeralHookSessionIdPrefix) ?? false;
}

function normalizedApprovalCallFromPortalCall(
	call: PortalApprovalCall,
): NormalizedPortalApprovalCall {
	return {
		arguments: call.arguments,
		id: call.id,
		namespace: call.namespace,
		toolName: call.toolName,
	};
}

function portalApprovalRequestsFromEventParams(
	params: Record<string, unknown>,
): readonly PortalApprovalRequest[] | null {
	if (!Array.isArray(params.calls)) {
		return null;
	}

	const requests: PortalApprovalRequest[] = [];
	for (const call of params.calls) {
		if (!isObjectRecord(call)) {
			return null;
		}
		const id = call.id;
		const namespace = call.namespace;
		const toolName = call.toolName;
		if (typeof id !== 'string' || typeof namespace !== 'string' || typeof toolName !== 'string') {
			return null;
		}
		const argumentsResult = jsonObjectSchema.safeParse(call.arguments);
		if (!argumentsResult.success) {
			return null;
		}
		requests.push({ arguments: argumentsResult.data, id, namespace, toolName });
	}

	return requests;
}

function normalizedApprovalCallsFromRequests(
	session: PortalSession,
	requests: readonly PortalApprovalRequest[],
): readonly NormalizedPortalApprovalCall[] | null {
	const normalizedCalls: NormalizedPortalApprovalCall[] = [];
	for (const request of requests) {
		const tool = findTool(session, request.namespace, request.toolName);
		if (!tool) {
			return null;
		}
		const validatedArguments = normalizePortalApprovalArguments(tool, request.arguments);
		if (!validatedArguments) {
			return null;
		}
		normalizedCalls.push({
			arguments: validatedArguments,
			id: request.id,
			namespace: tool.namespace,
			toolName: tool.toolName,
		});
	}

	return normalizedCalls;
}

function createPortalRuntimeBundle(api: OpenClawPortalPluginApi): PortalRuntimeBundle {
	const openClawConfig = api.config ?? {};
	const portalConfig = getPortalConfig(openClawConfig, api.pluginConfig);
	const agents = resolvePortalAgents(openClawConfig);
	const gatewayBaseUrl = getGatewayBaseUrl(openClawConfig);
	const bindingResult = createPortalBindingsForAgents({
		agents,
		baseUrl: gatewayBaseUrl,
		secretFactory: (agentId) =>
			getExistingBindingSecret(openClawConfig, agentId) ?? createPortalBindingSecret(),
	});
	const portalServerNames = new Set(bindingResult.bindings.map((binding) => binding.serverName));
	const normalized = normalizeOpenClawMcpServers(getMcpServersConfig(openClawConfig));
	for (const diagnostic of normalized.diagnostics) {
		api.logger?.warn?.(`[mcp-portal] skipped ${diagnostic.namespace}: ${diagnostic.message}`);
	}
	const upstreamServers = normalized.servers.filter(
		(server) => !portalServerNames.has(server.namespace) && !isPortalServerName(server.namespace),
	);
	const upstreamRuntime = createUpstreamMcpClientRuntime({
		additionalRedactionValues: bindingResult.bindings.map((binding) => binding.secret),
		servers: upstreamServers,
	});
	const sessionManager = createPortalSessionManager({
		accessPolicy: portalConfig,
		catalogTtlMs: portalConfig.cache.catalogTtlMs,
		discoveryFailures: normalized.diagnostics.map((diagnostic) => ({
			message: diagnostic.message,
			namespace: diagnostic.namespace,
		})),
		runtime: upstreamRuntime,
		upstreamNamespaces: upstreamServers.map((server) => server.namespace),
	});
	const approvalBridge = new InMemoryPortalApprovalBridge();
	const bindingsById = new Map<string, PortalHttpBinding>(
		bindingResult.bindings.map((binding) => [
			binding.bindingId,
			{ agentId: binding.agentId, bindingId: binding.bindingId, secret: binding.secret },
		]),
	);
	const callToolNames = new Map<string, PortalBindingIdentity>();
	for (const binding of bindingResult.bindings) {
		const callToolName = materializedPortalToolNames(binding.serverName).find((toolName) =>
			toolName.endsWith('__mcp_portal_call'),
		);
		if (callToolName) {
			callToolNames.set(callToolName, {
				agentId: binding.agentId,
				bindingId: binding.bindingId,
			});
		}
	}
	const app = createPortalHttpApp({
		getBinding: (bindingId) => bindingsById.get(bindingId) ?? null,
		onSessionClosed: async (identity) => {
			if (identity.sessionId !== undefined) {
				approvalBridge.clearTransportSession(identity.bindingId, identity.sessionId);
				approvalBridge.clearSession(identity.bindingId, identity.sessionId);
			}
			await sessionManager.invalidateSession(identity);
		},
		toolRuntime: {
			approval: (calls, identity, approvalNonce) => {
				const normalizedCalls = calls.map((call) => normalizedApprovalCallFromPortalCall(call));
				if (
					approvalBridge.hasAlways(
						createPersistentApprovalKey({ calls: normalizedCalls, identity }),
					)
				) {
					return { kind: 'allow' };
				}
				if (approvalNonce) {
					const approvalKey = createApprovalKey({
						approvalNonce,
						bindingId: identity.bindingId,
						calls: normalizedCalls,
					});
					const consumeResult = approvalBridge.consumeGrant(approvalKey);
					if (consumeResult.ok) {
						if (
							identity.sessionId !== undefined &&
							consumeResult.clearPersistentSessionOnConsume !== undefined
						) {
							approvalBridge.bindTransportSessionToPersistentSession({
								bindingId: identity.bindingId,
								persistentSessionId: consumeResult.clearPersistentSessionOnConsume.sessionId,
								transportSessionId: identity.sessionId,
							});
						}
						return { kind: 'allow' };
					}
				}
				const approvalDecisions = calls.map((call) =>
					resolvePortalApprovalDecision({
						annotations: call.tool.annotations,
						config: portalConfig.approval,
						namespace: call.namespace,
						toolName: call.toolName,
					}),
				);
				const approvalRequired = approvalDecisions.filter(
					(decision) => decision.kind === 'approval_required',
				);
				if (approvalRequired.length === 0) {
					return { kind: 'allow' };
				}
				const level = approvalRequired.some((decision) => decision.level === 'critical')
					? 'critical'
					: 'standard';
				return { kind: 'approval_required', level };
			},
			callUpstreamTool: upstreamRuntime.callTool,
			getSession: sessionManager.getSession,
		},
	});
	async function invalidateEphemeralHookIdentity(identity: PortalBindingIdentity): Promise<void> {
		if (isEphemeralHookIdentity(identity)) {
			if (identity.sessionId !== undefined) {
				approvalBridge.clearSession(identity.bindingId, identity.sessionId);
			}
			await sessionManager.invalidateSession(identity);
		}
	}

	return {
		app,
		bindings: bindingResult.bindings,
		callToolNames,
		close: async () => {
			await app.closePortalSessions();
			await Promise.all(
				bindingResult.bindings.map((binding) => {
					approvalBridge.clearBinding(binding.bindingId);
					return sessionManager.invalidateBinding(binding.bindingId);
				}),
			);
		},
		getPromptContext: async (identity) => {
			try {
				if (!portalConfig.promptContext.enabled) {
					return '';
				}
				const session = await sessionManager.getSession(identity);
				const namespaceCounts = new Map<string, number>();
				for (const tool of session.catalog.tools) {
					namespaceCounts.set(tool.namespace, (namespaceCounts.get(tool.namespace) ?? 0) + 1);
				}
				return createPortalPromptContext({
					diagnostics: session.catalog.discoveryFailures,
					namespaces: [...namespaceCounts.entries()]
						.toSorted(([left], [right]) => left.localeCompare(right))
						.slice(0, portalConfig.promptContext.maxNamespaces)
						.map(([namespace, toolCount]) => ({ namespace, toolCount })),
				});
			} finally {
				await invalidateEphemeralHookIdentity(identity);
			}
		},
		maybeRequireApproval: async (event, context) => {
			const bindingIdentity = callToolNames.get(event.toolName);
			if (
				!bindingIdentity ||
				(context.agentId !== undefined && context.agentId !== bindingIdentity.agentId)
			) {
				return undefined;
			}
			const resolvedIdentity = resolveHookIdentityFromBinding(bindingIdentity, context);
			const identity = resolvedIdentity.identity;
			const requests = portalApprovalRequestsFromEventParams(event.params);
			if (!requests || requests.length === 0) {
				return undefined;
			}
			try {
				const session = await sessionManager.getSession(identity);
				const normalizedCalls = normalizedApprovalCallsFromRequests(session, requests);
				if (!normalizedCalls) {
					return undefined;
				}
				const approvalDecisions = requests.flatMap((request) => {
					const tool = findTool(session, request.namespace, request.toolName);
					if (!tool) {
						return [];
					}
					return [
						resolvePortalApprovalDecision({
							annotations: tool.annotations,
							config: portalConfig.approval,
							namespace: tool.namespace,
							toolName: tool.toolName,
						}),
					];
				});
				const approvalRequired = approvalDecisions.filter(
					(decision) => decision.kind === 'approval_required',
				);
				if (approvalRequired.length === 0) {
					return undefined;
				}
				const persistentApprovalKey = createPersistentApprovalKey({
					calls: normalizedCalls,
					identity,
				});
				const approvalNonce = createApprovalNonce();
				event.params.portalApprovalNonce = approvalNonce;
				if (event.params.portalApprovalNonce !== approvalNonce) {
					return {
						block: true,
						blockReason:
							'MCP Portal could not attach a server-side approval nonce to the tool call.',
					};
				}
				const approvalKey = createApprovalKey({
					approvalNonce,
					bindingId: identity.bindingId,
					calls: normalizedCalls,
				});
				const persistentSession =
					persistentApprovalKey.sessionId !== undefined
						? {
								bindingId: persistentApprovalKey.bindingId,
								sessionId: persistentApprovalKey.sessionId,
							}
						: undefined;
				const grantOptions =
					persistentSession !== undefined
						? { clearPersistentSessionOnConsume: persistentSession }
						: {};
				if (approvalBridge.hasAlways(persistentApprovalKey)) {
					approvalBridge.grant(approvalKey, grantOptions);
					return undefined;
				}
				const toolNames = normalizedCalls
					.map((call) => `${call.namespace}.${call.toolName}`)
					.toSorted()
					.join(', ');
				const severity = approvalRequired.some((decision) => decision.level === 'critical')
					? 'critical'
					: 'warning';
				return {
					requireApproval: {
						description: `Allow MCP Portal batch for agent ${identity.agentId}: ${toolNames}.`,
						onResolution: (resolution: string) => {
							if (resolution === 'allow-once') {
								approvalBridge.grant(approvalKey);
							}
							if (resolution === 'allow-always') {
								approvalBridge.grant(approvalKey, grantOptions);
								approvalBridge.grantAlways(persistentApprovalKey);
							}
						},
						pluginId,
						severity,
						timeoutBehavior: 'deny',
						timeoutMs: 60_000,
						title: `MCP Portal batch: ${toolNames}`,
					},
				};
			} finally {
				if (resolvedIdentity.ephemeral) {
					await sessionManager.invalidateSession(identity);
				}
			}
		},
	};
}

function hookSessionIdFromContext(
	context: OpenClawPluginHookContext | OpenClawPromptHookContext,
): string | undefined {
	if (
		'sessionId' in context &&
		typeof context.sessionId === 'string' &&
		context.sessionId.length > 0
	) {
		return context.sessionId;
	}
	if (
		'sessionKey' in context &&
		typeof context.sessionKey === 'string' &&
		context.sessionKey.length > 0
	) {
		return context.sessionKey;
	}
	return undefined;
}

function resolveHookIdentityFromBinding(
	binding: PortalBindingIdentity,
	context: OpenClawPluginHookContext | OpenClawPromptHookContext,
): ResolvedPortalHookIdentity {
	const sessionId = hookSessionIdFromContext(context);
	if (sessionId !== undefined) {
		return {
			ephemeral: false,
			identity: { agentId: binding.agentId, bindingId: binding.bindingId, sessionId },
		};
	}

	return {
		ephemeral: true,
		identity: {
			agentId: binding.agentId,
			bindingId: binding.bindingId,
			sessionId: createEphemeralHookSessionId(),
		},
	};
}

function createPortalRuntimeReloader(api: OpenClawPortalPluginApi): PortalRuntimeReloader {
	const watcher = new PortalConfigWatcher();
	watcher.hasChanged(createPortalRuntimeFingerprintInput(api));
	let currentRuntime = createPortalRuntimeBundle(api);
	let reloadPromise: Promise<PortalRuntimeBundle> | null = null;

	return {
		close: async () => {
			await currentRuntime.close();
		},
		get: async () => {
			if (reloadPromise) {
				return reloadPromise;
			}
			if (!watcher.hasChanged(createPortalRuntimeFingerprintInput(api))) {
				return currentRuntime;
			}
			reloadPromise ??= (async () => {
				const nextRuntime = createPortalRuntimeBundle(api);
				await currentRuntime.close();
				currentRuntime = nextRuntime;
				reloadPromise = null;
				api.logger?.info?.(
					`[mcp-portal] reloaded ${currentRuntime.bindings.length} portal bindings.`,
				);
				return currentRuntime;
			})().catch((error: unknown) => {
				reloadPromise = null;
				throw error;
			});
			return reloadPromise;
		},
	};
}

export function createPortalRuntimeFingerprintInput(api: {
	readonly config?: unknown;
	readonly pluginConfig?: unknown;
}): unknown {
	return {
		config: api.config ?? null,
		pluginConfig: api.pluginConfig ?? null,
	};
}

function resolvePromptIdentity(
	bindings: readonly PortalBindingRecord[],
	context: OpenClawPluginHookContext | OpenClawPromptHookContext,
): PortalBindingIdentity | null {
	const agentId = context.agentId;
	if (!agentId) {
		return null;
	}
	const binding = bindings.find((candidate) => candidate.agentId === agentId);
	return binding ? resolveHookIdentityFromBinding(binding, context).identity : null;
}

export function validatePortalPluginApi(api: OpenClawPortalPluginApi): void {
	if (!hasFunction(api.registerHttpRoute)) {
		throw new Error('MCP Portal plugin requires OpenClaw registerHttpRoute API.');
	}
	if (!hasFunction(api.on) && !hasFunction(api.registerPromptHook)) {
		throw new Error('MCP Portal plugin requires OpenClaw prompt hook registration API.');
	}
	if (!hasFunction(api.onDispose)) {
		throw new Error('MCP Portal plugin requires an OpenClaw lifecycle cleanup API.');
	}
}

export function registerMcpPortalPlugin(api: OpenClawPortalPluginApi): void {
	if (api.registrationMode && api.registrationMode !== 'full') {
		return;
	}
	validatePortalPluginApi(api);
	const runtimeReloader = createPortalRuntimeReloader(api);

	api.registerHttpRoute?.({
		auth: 'plugin',
		handler: async (request: IncomingMessage, response: ServerResponse) => {
			const runtime = await runtimeReloader.get();
			const fetchRequest = createRequestFromIncomingMessage(request);
			const fetchResponse = await runtime.app.fetch(fetchRequest);
			return writeFetchResponseToServerResponse(fetchResponse, response);
		},
		match: 'prefix',
		path: '/mcp-portal',
		replaceExisting: true,
	});

	api.on?.(
		'before_prompt_build',
		async (_event, context) => {
			const runtime = await runtimeReloader.get();
			const identity = resolvePromptIdentity(runtime.bindings, context);
			if (!identity) {
				return undefined;
			}
			return { appendSystemContext: await runtime.getPromptContext(identity) };
		},
		{ priority: 80 },
	);

	api.on?.(
		'before_tool_call',
		async (event, context) => {
			const runtime = await runtimeReloader.get();
			return runtime.maybeRequireApproval(event, context);
		},
		{ priority: 80 },
	);

	if (!api.on && api.registerPromptHook) {
		api.registerPromptHook('before_prompt_build', async (context) => {
			const runtime = await runtimeReloader.get();
			const identity = resolvePromptIdentity(runtime.bindings, context);
			if (!identity) {
				return;
			}
			const promptContext = await runtime.getPromptContext(identity);
			context.appendPrompt?.(promptContext);
		});
	}

	api.onDispose?.(runtimeReloader.close);
	void runtimeReloader.get().then((runtime) => {
		api.logger?.info?.(`[mcp-portal] registered ${runtime.bindings.length} portal bindings.`);
	});
}

const pluginEntry = {
	description: 'Per-agent MCP Portal bindings for progressive MCP tool discovery.',
	id: pluginId,
	name: 'MCP Portal',
	register: registerMcpPortalPlugin,
} satisfies PortalPluginEntry;

export default pluginEntry;
