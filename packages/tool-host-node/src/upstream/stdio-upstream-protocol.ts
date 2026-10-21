import type { JsonObject } from '@agent-collaboration/tool-access/contracts';
import {
	redactThrownError,
	redactUpstreamCatalogValue,
} from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolSchema, type Progress, type Tool } from '@modelcontextprotocol/sdk/types.js';

import {
	messageFromUnknownError,
	type UpstreamMcpFailureClass,
} from '#node-host/upstream/stdio-upstream-errors';

export type UpstreamMcpTransportKind = 'stdio';
export interface NormalizedUpstreamMcpServer {
	readonly namespace: string;
	readonly transport: 'stdio';
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly connectionTimeoutMs?: number;
}

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

export type UpstreamMcpTransport = Pick<
	Transport,
	'start' | 'send' | 'close' | 'onclose' | 'onerror' | 'onmessage'
>;

export interface UpstreamMcpRuntimeOptions {
	readonly additionalRedactionValues?: readonly string[];
	readonly createClient?: () => UpstreamMcpClientLike;
	readonly createUpstreamMcpTransport: (
		server: NormalizedUpstreamMcpServer,
		transport: Exclude<UpstreamMcpTransportKind, 'auto-http'>,
	) => UpstreamMcpTransport;
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

export interface CachedClient {
	readonly client: UpstreamMcpClientLike;
}

export interface PendingClient {
	readonly generation: number;
	readonly promise: Promise<UpstreamMcpClientLike>;
}

export const defaultConnectionTimeoutMs = 12_000;
export const defaultMaxResponseBytes = 4 * 1_024 * 1_024;
const maxProviderErrorMessageCharacters = 2_000;

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMcpToolErrorResult(value: unknown): boolean {
	return isObjectRecord(value) && value.isError === true;
}

export function providerErrorMessageFromMcpToolError(value: unknown): string | undefined {
	if (!isObjectRecord(value) || !Array.isArray(value.content)) {
		return undefined;
	}
	const message = value.content
		.flatMap((contentBlock): readonly string[] => {
			if (
				!isObjectRecord(contentBlock) ||
				contentBlock.type !== 'text' ||
				typeof contentBlock.text !== 'string'
			) {
				return [];
			}
			return [contentBlock.text.trim()];
		})
		.filter((text) => text.length > 0)
		.join('\n');
	if (message.length === 0) {
		return undefined;
	}
	if (message.length <= maxProviderErrorMessageCharacters) {
		return message;
	}
	return `${message.slice(0, maxProviderErrorMessageCharacters)}…`;
}

export function failureClassFromHttpStatus(httpStatusCode: number): UpstreamMcpFailureClass {
	if (httpStatusCode === 401) return 'authentication';
	if (httpStatusCode === 403) return 'authorization';
	if (httpStatusCode === 429) return 'rate_limit';
	if (httpStatusCode >= 400 && httpStatusCode < 500) return 'invalid_request';
	return 'provider_error';
}

export function safeFailureFromUnknown(
	error: unknown,
	redactionValues: readonly string[],
): {
	readonly causeMessage: string;
	readonly failureClass?: UpstreamMcpFailureClass;
	readonly httpStatusCode?: number;
} {
	if (
		error instanceof Error &&
		error.constructor.name === 'StreamableHTTPError' &&
		'code' in error &&
		typeof error.code === 'number' &&
		Number.isInteger(error.code) &&
		error.code >= 100 &&
		error.code <= 599
	) {
		return {
			causeMessage: 'Remote MCP request failed.',
			failureClass: failureClassFromHttpStatus(error.code),
			httpStatusCode: error.code,
		};
	}
	const redactedError = redactThrownError(error, { exactValues: redactionValues });
	return { causeMessage: messageFromUnknownError(redactedError) };
}

export function isTransport(value: unknown): value is Transport {
	return (
		isObjectRecord(value) &&
		typeof value.start === 'function' &&
		typeof value.send === 'function' &&
		typeof value.close === 'function'
	);
}

export function createSdkClient(): UpstreamMcpClientLike {
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

export function cacheKey(agentScopeId: string, namespace: string): string {
	return `${agentScopeId}\n${namespace}`;
}

export function rootAgentScopeId(agentScopeId: string): string {
	return agentScopeId.split('\n', 1)[0] ?? agentScopeId;
}

export function transportAttempts(
	server: NormalizedUpstreamMcpServer,
): readonly Exclude<UpstreamMcpTransportKind, 'auto-http'>[] {
	return [server.transport];
}

export function redactionValuesFromServer(server: NormalizedUpstreamMcpServer): readonly string[] {
	return Object.values(server.env ?? {}).filter((value) => value.length > 0);
}

export function timeoutMsForServer(server: NormalizedUpstreamMcpServer): number {
	return server.connectionTimeoutMs ?? defaultConnectionTimeoutMs;
}

export function elapsedMsSince(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

export function assertUpstreamResponseSize(value: unknown, maxResponseBytes: number): void {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		return;
	}
	const byteLength = new TextEncoder().encode(serialized).byteLength;
	if (byteLength > maxResponseBytes) {
		throw new Error(
			`MCP upstream response exceeded ${String(maxResponseBytes)} bytes (${String(byteLength)} bytes).`,
		);
	}
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

export function isCallerAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true && (error === signal.reason || isAbortError(error));
}

export async function withTimeout<TResult>(
	promise: Promise<TResult>,
	props: {
		readonly onTimeout?: (error: Error) => void;
		readonly operation: string;
		readonly timeoutMs: number;
	},
): Promise<TResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
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

export function createRuntimeAbortSignal(parentSignal: AbortSignal | undefined): {
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

export async function listAllTools(
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

export async function closeClientAfterFailure(client: UpstreamMcpClientLike | null): Promise<void> {
	if (!client) {
		return;
	}
	try {
		await client.close();
	} catch {
		// Preserve the original upstream failure; close errors are best-effort cleanup.
	}
}

export async function closeClientForTeardown(
	client: UpstreamMcpClientLike | null,
	props: {
		readonly context: UpstreamMcpCloseErrorContext;
		readonly redactionValues: readonly string[];
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
		props.onCloseError?.(
			redactThrownError(error, { exactValues: props.redactionValues }),
			props.context,
		);
	}
}

export function closeErrorContextFromCacheKey(cacheKeyValue: string): UpstreamMcpCloseErrorContext {
	const keyParts = cacheKeyValue.split('\n');
	const namespace = keyParts.length > 1 ? keyParts[keyParts.length - 1] : undefined;
	const agentScopeId =
		namespace !== undefined ? keyParts.slice(0, keyParts.length - 1).join('\n') : cacheKeyValue;
	return {
		agentScopeId,
		...(namespace !== undefined ? { namespace } : {}),
	};
}

export function redactToolCatalog(
	tools: readonly Tool[],
	options: { readonly exactValues: readonly string[] },
): readonly Tool[] {
	return tools.map((tool) => ToolSchema.parse(redactUpstreamCatalogValue(tool, options)));
}
