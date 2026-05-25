import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { jsonObjectSchema, type JsonValue } from '../json-schema.js';
import {
	createPortalAgentIdentity,
	resolvePortalAccessPolicy,
	type PortalAccessPolicyConfig,
	type PortalAgentIdentity,
	type PortalAgentScopeSource,
} from '../portal-access-policy.js';
import {
	createPortalSessionManager,
	type PortalSessionManager,
	type PortalSessionRuntime,
} from '../portal-session.js';
import type { SkillGraphInput } from '../tool-graph.js';
import { isPortalCoreJsonValue } from './portal-core-validation.js';
import {
	createPortalToolHandlers,
	portalToolInputSchemas,
	preparePortalApprovalCallDigests,
	type PortalApprovalCallDigestMap,
	type PortalApprovalCall,
	type PortalBatchDiagnostic,
	type PortalBatchResult,
	type PortalToolResult,
	type PortalToolRuntime,
} from './portal-tools.js';

export type PortalAgentScope = PortalAgentIdentity;

export type PortalCoreToolName =
	| 'mcp_portal_list'
	| 'mcp_portal_search'
	| 'mcp_portal_describe'
	| 'mcp_portal_call';

export interface PortalAuditEvent {
	readonly causeMessage?: string;
	readonly elapsedMs?: number;
	readonly hint?: string;
	readonly kind: string;
	readonly message: string;
	readonly namespace?: string;
	readonly operation?: string;
	readonly phase?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport?: unknown;
}

export interface PortalCoreResult {
	readonly auditEvents?: readonly PortalAuditEvent[];
	readonly content: readonly PortalCoreContentBlock[];
	readonly items: readonly PortalCoreItemResult[];
	readonly structuredContent?: unknown;
}

export type PortalCoreItemResult =
	| {
			readonly content: readonly PortalCoreContentBlock[];
			readonly requestId: string;
			readonly status: 'success';
			readonly structuredContent?: unknown;
	  }
	| {
			readonly error: PortalCoreItemError;
			readonly requestId: string;
			readonly status: 'failed';
	  };

export interface PortalCoreItemError {
	readonly code: string;
	readonly issues?: readonly PortalCoreValidationIssue[];
	readonly issueCount?: number;
	readonly issuesTruncated?: number;
	readonly message: string;
	readonly namespace?: string;
	readonly toolName?: string;
	readonly upstream?: unknown;
}

export interface PortalCoreValidationIssue {
	readonly code: string;
	readonly expected?: string;
	readonly keys?: readonly string[];
	readonly message: string;
	readonly path: readonly (number | string)[];
	readonly received?: {
		readonly preview?: string;
		readonly type: string;
	};
	readonly values?: readonly JsonValue[];
}

export type PortalCoreContentBlock =
	| { readonly text: string; readonly type: 'text' }
	| { readonly type: 'json'; readonly value: unknown };

export type PortalCoreEvent =
	| {
			readonly kind: 'started';
			readonly toolName: PortalCoreToolName;
	  }
	| {
			readonly kind: 'item_started';
			readonly namespace?: string;
			readonly requestId: string;
			readonly toolName?: string;
	  }
	| {
			readonly kind: 'progress';
			readonly message?: string;
			readonly progress?: number;
			readonly requestId?: string;
			readonly total?: number;
	  }
	| {
			readonly kind: 'upstream_notification';
			readonly method: string;
			readonly params: unknown;
			readonly requestId?: string;
	  }
	| {
			readonly content: PortalCoreContentBlock;
			readonly kind: 'partial_content';
			readonly requestId?: string;
	  }
	| {
			readonly kind: 'item_completed';
			readonly requestId: string;
			readonly result: Extract<PortalCoreItemResult, { readonly status: 'success' }>;
	  }
	| {
			readonly error: PortalCoreItemError;
			readonly kind: 'item_failed';
			readonly requestId: string;
	  }
	| {
			readonly kind: 'completed';
			readonly result: PortalCoreResult;
	  }
	| {
			readonly error: unknown;
			readonly kind: 'failed';
	  };

export interface PortalCoreStreamCall {
	readonly input: unknown;
	readonly scope: PortalAgentScope;
	readonly signal?: AbortSignal;
	readonly toolName: PortalCoreToolName;
}

const maxQueuedPortalCoreEvents = 1_024;
const maxPortalCoreEventBytes = 256 * 1_024;
const maxAgentFacingValidationIssues = 5;

export interface PortalCoreCollectOptions {
	readonly onEvent?: (event: PortalCoreEvent) => Promise<void> | void;
}

export interface PortalCoreRuntime extends PortalSessionRuntime {
	readonly callUpstreamTool: PortalToolRuntime['callUpstreamTool'];
}

export type PortalApprovalEvaluator = NonNullable<PortalToolRuntime['approval']>;

interface CreatePortalCoreBaseProps {
	readonly accessPolicy: PortalAccessPolicyConfig;
	readonly catalogTtlMs: number;
	readonly runtime: PortalCoreRuntime;
	readonly skills?: readonly SkillGraphInput[];
	readonly upstreamNamespaces: readonly string[];
}

export interface CreatePortalCoreProps extends CreatePortalCoreBaseProps {
	readonly approval: PortalApprovalEvaluator;
}

export interface PortalCore {
	readonly approval: {
		readonly evaluateCalls: (
			calls: readonly PortalApprovalCall[],
			scope: PortalAgentScope,
			approvalToken: string | undefined,
		) => ReturnType<PortalApprovalEvaluator>;
		readonly prepareCallDigests: (props: {
			readonly input: unknown;
			readonly scope: PortalAgentScope;
		}) => Promise<PortalApprovalCallDigestMap | null>;
	};
	readonly callStream: (call: PortalCoreStreamCall) => AsyncIterable<PortalCoreEvent>;
	readonly close: () => Promise<void>;
	readonly collectPortalCoreResult: typeof collectPortalCoreResult;
	readonly createAgentScope: (input: {
		readonly agentId: string;
		readonly agentScopeId: string;
		readonly authSubject?: string;
		readonly sessionId?: string;
		readonly sessionKey?: string;
		readonly source: PortalAgentScopeSource;
	}) => PortalAgentScope;
	readonly describeTools: (scope: PortalAgentScope) => readonly PortalCoreToolDescriptor[];
	readonly invalidateAgentScope: (agentScopeId: string) => Promise<void>;
	readonly invalidateSession: (scope: PortalAgentScope) => Promise<void>;
	readonly upstreamNamespaces: readonly string[];
}

export interface PortalCoreToolDescriptor {
	readonly description: string;
	readonly inputSchema: Tool['inputSchema'];
	readonly name: PortalCoreToolName;
}

const portalCallRequestSchema = z
	.object({
		arguments: jsonObjectSchema,
		id: z.string().min(1),
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();
const portalCallInputSchema = z
	.object({
		calls: z.array(portalCallRequestSchema).min(1),
		portalApprovalToken: z.string().min(1).optional(),
	})
	.strict();

function diagnosticsToAuditEvents(
	diagnostics: readonly PortalBatchDiagnostic[],
): readonly PortalAuditEvent[] {
	return diagnostics.map((diagnostic) => ({ ...diagnostic }));
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorRecordFromUnknown(error: unknown): Record<string, unknown> {
	return isUnknownRecord(error) ? error : {};
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isJsonValueArray(value: unknown): value is readonly JsonValue[] {
	return Array.isArray(value) && value.every((entry) => isPortalCoreJsonValue(entry));
}

function isValidationIssueReceived(
	value: unknown,
): value is { readonly preview?: string; readonly type: string } {
	return (
		isUnknownRecord(value) &&
		typeof value.type === 'string' &&
		(value.preview === undefined || typeof value.preview === 'string')
	);
}

function isValidationIssue(value: unknown): value is PortalCoreValidationIssue {
	return (
		isUnknownRecord(value) &&
		typeof value.code === 'string' &&
		typeof value.message === 'string' &&
		Array.isArray(value.path) &&
		value.path.every((pathPart) => typeof pathPart === 'string' || typeof pathPart === 'number') &&
		(value.expected === undefined || typeof value.expected === 'string') &&
		(value.keys === undefined || isStringArray(value.keys)) &&
		(value.received === undefined || isValidationIssueReceived(value.received)) &&
		(value.values === undefined || isJsonValueArray(value.values))
	);
}

function validationIssuesFromUnknown(
	error: unknown,
): readonly PortalCoreValidationIssue[] | undefined {
	const issues = errorRecordFromUnknown(error).issues;
	if (!Array.isArray(issues)) {
		return undefined;
	}
	const validationIssues = issues.filter((issue): issue is PortalCoreValidationIssue =>
		isValidationIssue(issue),
	);
	return validationIssues.length > 0 ? validationIssues : undefined;
}

function validationIssuePathLabel(path: readonly (number | string)[]): string {
	return path.length === 0 ? '(root)' : path.map((pathPart) => String(pathPart)).join('.');
}

function formattedJsonValue(value: JsonValue): string {
	const serialized = JSON.stringify(value);
	return serialized ?? '[unserializable-json-value]';
}

function receivedValueLabel(received: PortalCoreValidationIssue['received']): string | undefined {
	if (received === undefined) {
		return undefined;
	}
	if (received.preview === undefined) {
		return received.type;
	}
	const preview = received.type === 'string' ? JSON.stringify(received.preview) : received.preview;
	return `${received.type} ${preview}`;
}

function validationIssueSummary(issue: PortalCoreValidationIssue): string {
	const details = [
		issue.expected === undefined ? undefined : `expected ${issue.expected}`,
		issue.values === undefined
			? undefined
			: `allowed values ${issue.values.map((value) => formattedJsonValue(value)).join(', ')}`,
		issue.keys === undefined ? undefined : `unrecognized keys ${issue.keys.join(', ')}`,
		receivedValueLabel(issue.received) === undefined
			? undefined
			: `received ${receivedValueLabel(issue.received)}`,
		issue.message,
	].filter((detail): detail is string => detail !== undefined);
	return `${validationIssuePathLabel(issue.path)}: ${details.join('; ')}`;
}

function agentFacingValidationIssues(
	issues: readonly PortalCoreValidationIssue[],
): readonly PortalCoreValidationIssue[] {
	return issues.slice(0, maxAgentFacingValidationIssues);
}

function messageFromValidationIssues(issues: readonly PortalCoreValidationIssue[]): string {
	const shownIssues = agentFacingValidationIssues(issues);
	const truncatedIssues = issues.length - shownIssues.length;
	const suffix =
		truncatedIssues > 0
			? ` | ${String(truncatedIssues)} more validation issue(s) omitted; call describe for the exact schema.`
			: '';
	return `Input validation failed: ${shownIssues
		.map((issue) => validationIssueSummary(issue))
		.join(' | ')}${suffix}`;
}

function messageFromUnknown(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	const validationIssues = validationIssuesFromUnknown(error);
	if (validationIssues !== undefined) {
		return messageFromValidationIssues(validationIssues);
	}
	const record = errorRecordFromUnknown(error);
	const message = record.message;
	return typeof message === 'string' ? message : String(error);
}

function errorFromAbortSignal(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new Error('MCP Portal core stream aborted.');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw errorFromAbortSignal(signal);
	}
}

function assertPortalCoreEventSize(event: PortalCoreEvent): void {
	const serialized = JSON.stringify(event);
	if (serialized === undefined) {
		return;
	}
	const byteLength = Buffer.byteLength(serialized, 'utf8');
	if (byteLength > maxPortalCoreEventBytes) {
		throw new Error(
			`MCP Portal core event exceeded ${String(maxPortalCoreEventBytes)} bytes (${String(byteLength)} bytes).`,
		);
	}
}

function waitForQueuedCoreEvent(props: {
	readonly setNotifyQueuedEvent: (notify: (() => void) | undefined) => void;
	readonly signal?: AbortSignal;
}): Promise<void> {
	if (props.signal === undefined) {
		return new Promise<void>((resolve) => {
			props.setNotifyQueuedEvent(resolve);
		});
	}
	const signal = props.signal;
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const settle = (complete: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener('abort', onAbort);
			props.setNotifyQueuedEvent(undefined);
			complete();
		};
		const onNotify = (): void => {
			settle(resolve);
		};
		const onAbort = (): void => {
			settle(() => reject(errorFromAbortSignal(signal)));
		};
		props.setNotifyQueuedEvent(onNotify);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
	});
}

function itemErrorFromPortalResult(result: PortalToolResult): PortalCoreItemError {
	if (result.ok) {
		throw new Error('Cannot convert successful portal result into an item error.');
	}
	const errorRecord = errorRecordFromUnknown(result.error);
	const kind = errorRecord.kind;
	const namespace = errorRecord.namespace;
	const toolName = errorRecord.toolName;
	const upstream = errorRecord.upstream;
	const issues = validationIssuesFromUnknown(result.error);
	const shownIssues = issues === undefined ? undefined : agentFacingValidationIssues(issues);
	const issuesTruncated =
		issues === undefined || shownIssues === undefined
			? undefined
			: issues.length - shownIssues.length;

	return {
		code: typeof kind === 'string' ? kind : 'portal_item_failed',
		message: messageFromUnknown(result.error),
		...(issues === undefined || shownIssues === undefined
			? {}
			: {
					issueCount: issues.length,
					issues: shownIssues,
					...(issuesTruncated === undefined || issuesTruncated <= 0 ? {} : { issuesTruncated }),
				}),
		...(typeof namespace === 'string' ? { namespace } : {}),
		...(typeof toolName === 'string' ? { toolName } : {}),
		...(upstream === undefined ? {} : { upstream }),
	};
}

function itemResultFromPortalToolResult(
	requestId: string,
	result: PortalToolResult,
): PortalCoreItemResult {
	if (!result.ok) {
		return {
			error: itemErrorFromPortalResult(result),
			requestId,
			status: 'failed',
		};
	}

	return {
		content: [{ type: 'json', value: result.output }],
		requestId,
		status: 'success',
		structuredContent: result.output,
	};
}

function scalarBatchResultToCoreResult(batchResult: PortalBatchResult): PortalCoreResult {
	return {
		auditEvents: diagnosticsToAuditEvents(batchResult.diagnostics),
		content: [{ type: 'json', value: batchResult }],
		items: [],
		structuredContent: batchResult,
	};
}

function batchItemsToCoreResult(props: {
	readonly diagnostics: readonly PortalBatchDiagnostic[];
	readonly items: readonly PortalCoreItemResult[];
}): PortalCoreResult {
	return {
		auditEvents: diagnosticsToAuditEvents(props.diagnostics),
		content: [],
		items: props.items,
	};
}

function namespaceDescription(namespaces: readonly string[]): string {
	return namespaces.length === 0
		? 'No upstream MCP namespaces are authorized for this agent scope.'
		: `Allowed namespaces for this agent: ${namespaces.join(', ')}.`;
}

function cloneJsonObject<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

function withListNamespaceSchemaDescription(
	inputSchema: Tool['inputSchema'],
	namespaces: readonly string[],
): Tool['inputSchema'] {
	const clonedSchema = cloneJsonObject(inputSchema);
	const requests = isUnknownRecord(clonedSchema.properties)
		? clonedSchema.properties.requests
		: undefined;
	const requestItems = isUnknownRecord(requests) ? requests.items : undefined;
	const requestProperties = isUnknownRecord(requestItems) ? requestItems.properties : undefined;
	const namespaceProperty = isUnknownRecord(requestProperties)
		? requestProperties.namespaces
		: undefined;
	if (isUnknownRecord(namespaceProperty)) {
		namespaceProperty.description =
			namespaces.length === 0
				? 'Optional namespace filter. No upstream MCP namespaces are authorized for this agent. Omit to list all currently discovered authorized namespaces.'
				: `Optional namespace filter. Allowed namespaces for this agent: ${namespaces.join(', ')}. Omit to list all currently discovered authorized namespaces.`;
	}
	return clonedSchema;
}

export function listPortalCoreToolDescriptors(
	namespaces: readonly string[] = [],
): readonly PortalCoreToolDescriptor[] {
	const scopeDescription = namespaceDescription(namespaces);
	return [
		{
			description: `List authorized MCP namespaces and compact tool summaries. ${scopeDescription}`,
			inputSchema: withListNamespaceSchemaDescription(
				portalToolInputSchemas.mcp_portal_list,
				namespaces,
			),
			name: 'mcp_portal_list',
		},
		{
			description: 'Search the caller scoped MCP Portal index.',
			inputSchema: portalToolInputSchemas.mcp_portal_search,
			name: 'mcp_portal_search',
		},
		{
			description: 'Describe exact MCP tool schemas and optional TypeScript/Zod helpers.',
			inputSchema: portalToolInputSchemas.mcp_portal_describe,
			name: 'mcp_portal_describe',
		},
		{
			description: 'Validate and call an authorized upstream MCP tool by namespace and toolName.',
			inputSchema: portalToolInputSchemas.mcp_portal_call,
			name: 'mcp_portal_call',
		},
	];
}

export async function collectPortalCoreResult(
	events: AsyncIterable<PortalCoreEvent>,
	options: PortalCoreCollectOptions = {},
): Promise<PortalCoreResult> {
	let result: PortalCoreResult | undefined;
	for await (const event of events) {
		await options.onEvent?.(event);
		if (event.kind === 'completed') {
			result = event.result;
		}
		if (event.kind === 'failed') {
			throw event.error;
		}
	}
	if (result === undefined) {
		throw new Error('MCP Portal core stream ended without a completed event.');
	}
	return result;
}

async function* scalarToolStream(props: {
	readonly input: unknown;
	readonly scope: PortalAgentScope;
	readonly signal?: AbortSignal;
	readonly sessionManager: PortalSessionManager;
	readonly toolName: Exclude<PortalCoreToolName, 'mcp_portal_call'>;
	readonly toolRuntime: PortalToolRuntime;
}): AsyncIterable<PortalCoreEvent> {
	const handlers = createPortalToolHandlers(props.toolRuntime);
	const handler =
		props.toolName === 'mcp_portal_list'
			? handlers.list
			: props.toolName === 'mcp_portal_search'
				? handlers.search
				: handlers.describe;
	throwIfAborted(props.signal);
	const batchResult = await handler({ identity: props.scope, input: props.input });
	throwIfAborted(props.signal);
	yield { kind: 'completed', result: scalarBatchResultToCoreResult(batchResult) };
}

async function* callToolStream(props: {
	readonly input: unknown;
	readonly scope: PortalAgentScope;
	readonly signal?: AbortSignal;
	readonly toolRuntime: PortalToolRuntime;
}): AsyncIterable<PortalCoreEvent> {
	const parsedInput = portalCallInputSchema.safeParse(props.input);
	const queuedEvents: PortalCoreEvent[] = [];
	let notifyQueuedEvent: (() => void) | undefined;
	let executionDone = false;
	const pushEvent = (event: PortalCoreEvent): void => {
		assertPortalCoreEventSize(event);
		if (queuedEvents.length >= maxQueuedPortalCoreEvents) {
			throw new Error(`MCP Portal core event queue exceeded ${maxQueuedPortalCoreEvents} events.`);
		}
		queuedEvents.push(event);
		notifyQueuedEvent?.();
		notifyQueuedEvent = undefined;
	};
	const streamingToolRuntime: PortalToolRuntime = {
		...props.toolRuntime,
		callUpstreamTool: async (call) => {
			throwIfAborted(props.signal);
			pushEvent({
				kind: 'item_started',
				namespace: call.namespace,
				requestId: call.requestId,
				toolName: call.toolName,
			});
			pushEvent({
				kind: 'progress',
				message: `Calling upstream MCP tool ${call.namespace}.${call.toolName}.`,
				requestId: call.requestId,
			});
			return await props.toolRuntime.callUpstreamTool({
				...call,
				...(props.signal !== undefined ? { signal: props.signal } : {}),
				onEvent: (event) => {
					if (event.kind === 'progress') {
						pushEvent({
							kind: 'progress',
							...(event.message !== undefined ? { message: event.message } : {}),
							...(event.progress !== undefined ? { progress: event.progress } : {}),
							requestId: call.requestId,
							...(event.total !== undefined ? { total: event.total } : {}),
						});
						return;
					}
					if (event.kind === 'partial_content') {
						pushEvent({
							content: event.content,
							kind: 'partial_content',
							requestId: call.requestId,
						});
						return;
					}
					pushEvent({
						kind: 'upstream_notification',
						method: event.method,
						params: event.params,
						requestId: call.requestId,
					});
				},
			});
		},
	};
	const handlers = createPortalToolHandlers(streamingToolRuntime);
	if (!parsedInput.success) {
		const batchResult = await handlers.call({ identity: props.scope, input: props.input });
		yield { kind: 'completed', result: scalarBatchResultToCoreResult(batchResult) };
		return;
	}

	const itemResults: PortalCoreItemResult[] = [];
	const batchResultPromise = handlers
		.call({
			identity: props.scope,
			input: props.input,
		})
		.finally(() => {
			executionDone = true;
			notifyQueuedEvent?.();
			notifyQueuedEvent = undefined;
		});
	const hasPendingExecutionEvents = (): boolean => !executionDone || queuedEvents.length > 0;
	while (hasPendingExecutionEvents()) {
		const event = queuedEvents.shift();
		if (event !== undefined) {
			yield event;
			continue;
		}
		throwIfAborted(props.signal);
		// Streaming consumes events as they arrive; there is no parallel work to collect here.
		// eslint-disable-next-line no-await-in-loop
		await waitForQueuedCoreEvent({
			setNotifyQueuedEvent: (notify) => {
				notifyQueuedEvent = notify;
			},
			...(props.signal !== undefined ? { signal: props.signal } : {}),
		});
	}
	const batchResult = await batchResultPromise;
	throwIfAborted(props.signal);
	if (batchResult.errors.length > 0) {
		yield { kind: 'completed', result: scalarBatchResultToCoreResult(batchResult) };
		return;
	}
	for (const request of parsedInput.data.calls) {
		const portalResult = batchResult.results[request.id];
		const itemResult =
			portalResult === undefined
				? ({
						error: {
							code: 'portal_item_missing',
							message: `MCP Portal did not return a result for request "${request.id}".`,
							namespace: request.namespace,
							toolName: request.toolName,
						},
						requestId: request.id,
						status: 'failed',
					} satisfies PortalCoreItemResult)
				: itemResultFromPortalToolResult(request.id, portalResult);
		itemResults.push(itemResult);
		if (itemResult.status === 'success') {
			yield { kind: 'item_completed', requestId: request.id, result: itemResult };
		} else {
			yield { error: itemResult.error, kind: 'item_failed', requestId: request.id };
		}
	}

	yield {
		kind: 'completed',
		result: batchItemsToCoreResult({ diagnostics: batchResult.diagnostics, items: itemResults }),
	};
}

export function createPortalCore(props: CreatePortalCoreProps): PortalCore {
	const sessionManager = createPortalSessionManager({
		accessPolicy: props.accessPolicy,
		catalogTtlMs: props.catalogTtlMs,
		runtime: props.runtime,
		...(props.skills !== undefined ? { skills: props.skills } : {}),
		upstreamNamespaces: props.upstreamNamespaces,
	});
	const createdAgentScopeIds = new Set<string>();
	const approval = props.approval;
	const toolRuntime: PortalToolRuntime = {
		approval,
		callUpstreamTool: props.runtime.callUpstreamTool,
		getSession: sessionManager.getSession,
	};

	async function* callStream(call: PortalCoreStreamCall): AsyncIterable<PortalCoreEvent> {
		try {
			throwIfAborted(call.signal);
			yield { kind: 'started', toolName: call.toolName };
			throwIfAborted(call.signal);
			if (call.toolName === 'mcp_portal_call') {
				yield* callToolStream({
					input: call.input,
					scope: call.scope,
					...(call.signal !== undefined ? { signal: call.signal } : {}),
					toolRuntime,
				});
				return;
			}
			yield* scalarToolStream({
				input: call.input,
				scope: call.scope,
				...(call.signal !== undefined ? { signal: call.signal } : {}),
				sessionManager,
				toolName: call.toolName,
				toolRuntime,
			});
		} catch (error) {
			yield { error, kind: 'failed' };
		}
	}

	return {
		approval: {
			evaluateCalls: (calls, scope, approvalToken) => approval(calls, scope, approvalToken),
			prepareCallDigests: async ({ input, scope }) => {
				const session = await sessionManager.getSession(scope);
				return preparePortalApprovalCallDigests(session, input);
			},
		},
		callStream,
		close: async () => {
			await Promise.all(
				[...createdAgentScopeIds].map((agentScopeId) =>
					sessionManager.invalidateAgentScope(agentScopeId),
				),
			);
		},
		collectPortalCoreResult,
		createAgentScope: (input) => {
			const scope = createPortalAgentIdentity(input);
			createdAgentScopeIds.add(scope.agentScopeId);
			return scope;
		},
		describeTools: (scope) => {
			const policy = resolvePortalAccessPolicy({
				config: props.accessPolicy,
				identity: scope,
				upstreamNamespaces: props.upstreamNamespaces,
			});
			return listPortalCoreToolDescriptors(policy.allowedNamespaces);
		},
		invalidateAgentScope: async (agentScopeId) => {
			createdAgentScopeIds.delete(agentScopeId);
			await sessionManager.invalidateAgentScope(agentScopeId);
		},
		invalidateSession: async (scope) => {
			await sessionManager.invalidateSession(scope);
		},
		upstreamNamespaces: props.upstreamNamespaces,
	};
}
