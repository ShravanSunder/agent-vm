import { randomUUID } from 'node:crypto';

import {
	PortalCallRequestSchema,
	type PortalCallResult,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	type PortalBackendDescribeResult,
	PortalBackendDescribeResultSchema,
	PortalListRequestSchema,
	type PortalBackendListResult,
	PortalBackendListResultSchema,
	PortalSearchRequestSchema,
	type PortalBackendSearchResult,
	PortalBackendSearchResultSchema,
	JsonValueSchema,
	type PortalError,
	type SafeDiagnostic,
	type JsonValue,
} from '@agent-vm/agent-portal-sdk';
import {
	type FormattedSecretValue,
	loadMcpConfig,
	mcpConfigSchema,
	type McpConfig,
	type ToolPortalMcpProjection,
	ToolPortalMcpProjectionSchema,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import { z } from 'zod';

import {
	createPortalCore,
	createUpstreamMcpClientRuntime,
	resolveUpstreamServers,
} from '../core/index.js';
import type {
	PortalBatchDiagnostic,
	PortalBatchResult,
	PortalCore,
	PortalCoreEvent,
	PortalCoreResult,
	PortalCoreToolName,
	PortalToolResult,
} from '../core/index.js';
import type { PortalAgentScopeSource } from '../portal-access-policy.js';
import { portalErrorFromUnknown, safeDiagnosticForCode } from './mcp-provider-model-errors.js';

export interface McpProviderCapabilityBackendCallOptions {
	readonly operationIdsByCallId?: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
}

export interface McpProviderCapabilityBackend {
	readonly call: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalBackendDescribeResult>;
	readonly list: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalBackendListResult>;
	readonly search: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalBackendSearchResult>;
}

export interface CreateMcpProviderCapabilityBackendProps {
	readonly core: PortalCore;
	readonly portalAgentScopeSource?: PortalAgentScopeSource;
	readonly projection: ToolPortalMcpProjection;
	readonly sessionKey?: string;
}

export interface McpProviderBackendSessionOptions {
	readonly portalAgentScopeSource?: PortalAgentScopeSource;
	readonly sessionKey?: string;
}

export interface ManagedMcpProviderBackendFactory {
	readonly close: () => Promise<void>;
	readonly createBackend: (
		projection: ToolPortalMcpProjection,
		options?: McpProviderBackendSessionOptions,
	) => McpProviderCapabilityBackend;
	readonly retireSession: (sessionKey: string) => Promise<void>;
}

export interface CreateManagedMcpProviderBackendFactoryProps {
	readonly mcpConfigPath: string;
	readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
}

export interface CreateManagedMcpProviderBackendFactoryFromConfigProps {
	readonly mcpConfig: McpConfig;
	readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
}

interface TrackedMcpProviderAgentScope {
	readonly agentId: string;
	readonly portalAgentScopeSource: PortalAgentScopeSource;
}

type PreflightCallDecision =
	| { readonly kind: 'allow' }
	| { readonly code: 'approval_required' | 'capability_denied'; readonly kind: 'error' };

const operationIdSchema = z.string().uuid();

function operationIdsForCalls(props: {
	readonly calls: readonly { readonly id: string }[];
	readonly suppliedOperationIdsByCallId: Readonly<Record<string, string>> | undefined;
}): ReadonlyMap<string, string> {
	if (props.suppliedOperationIdsByCallId === undefined) {
		return new Map(props.calls.map((call) => [call.id, randomUUID()]));
	}
	const suppliedEntries = Object.entries(props.suppliedOperationIdsByCallId);
	const suppliedOperationIds = new Map(suppliedEntries);
	if (
		suppliedEntries.length !== props.calls.length ||
		props.calls.some((call) => !suppliedOperationIds.has(call.id))
	) {
		throw new Error('MCP provider operation identity map must match request call ids exactly.');
	}
	return new Map(
		props.calls.map((call) => {
			const operationId = suppliedOperationIds.get(call.id);
			const parsedOperationId = operationIdSchema.safeParse(operationId);
			if (!parsedOperationId.success) {
				throw new Error('MCP provider operation identity map must contain UUID values.');
			}
			return [call.id, parsedOperationId.data];
		}),
	);
}

interface NormalizedScalarPortalItem {
	readonly error?: PortalError;
	readonly id: string;
	readonly status: 'error' | 'ok';
	readonly value?: JsonValue;
}

interface NormalizedScalarPortalResult {
	readonly diagnostics?: readonly SafeDiagnostic[];
	readonly items: readonly NormalizedScalarPortalItem[];
	readonly ok: boolean;
}

export async function createManagedMcpProviderBackendFactory(
	props: CreateManagedMcpProviderBackendFactoryProps,
): Promise<ManagedMcpProviderBackendFactory> {
	return await createManagedMcpProviderBackendFactoryFromConfig({
		mcpConfig: await loadMcpConfig(props.mcpConfigPath),
		resolveSecret: props.resolveSecret,
	});
}

export async function createManagedMcpProviderBackendFactoryFromConfig(
	props: CreateManagedMcpProviderBackendFactoryFromConfigProps,
): Promise<ManagedMcpProviderBackendFactory> {
	const mcpConfig = mcpConfigSchema.parse(props.mcpConfig);
	const upstreamServers = await resolveUpstreamServers({
		config: mcpConfig,
		resolveSecret: props.resolveSecret,
	});
	const upstreamRuntime = createUpstreamMcpClientRuntime({ servers: upstreamServers });
	const core = createPortalCore({
		accessPolicy: {
			defaultPolicy: 'allow-all',
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
		approval: (approvalCalls) => ({
			decisionsByCallId: Object.fromEntries(
				approvalCalls.map((call) => [call.id, { kind: 'allow' }]),
			),
		}),
		catalogTtlMs: 60_000,
		runtime: {
			callUpstreamTool: upstreamRuntime.callTool,
			closeAgentScope: upstreamRuntime.closeAgentScope,
			closeSession: upstreamRuntime.closeSession,
			listTools: upstreamRuntime.listTools,
		},
		upstreamNamespaces: upstreamServers.map((server) => server.namespace),
	});
	const agentScopesBySessionKey = new Map<string, Map<string, TrackedMcpProviderAgentScope>>();
	return {
		close: async () => await core.close(),
		createBackend: (projection, backendOptions = {}): McpProviderCapabilityBackend => {
			const parsedProjection = ToolPortalMcpProjectionSchema.parse(projection);
			const portalAgentScopeSource = backendOptions.portalAgentScopeSource ?? 'openclaw-trusted';
			if (backendOptions.sessionKey !== undefined) {
				const agentScopes =
					agentScopesBySessionKey.get(backendOptions.sessionKey) ??
					new Map<string, TrackedMcpProviderAgentScope>();
				agentScopes.set(`${portalAgentScopeSource}\0${parsedProjection.agentId}`, {
					agentId: parsedProjection.agentId,
					portalAgentScopeSource,
				});
				agentScopesBySessionKey.set(backendOptions.sessionKey, agentScopes);
			}
			return createMcpProviderCapabilityBackend({
				core,
				portalAgentScopeSource,
				projection: parsedProjection,
				...(backendOptions.sessionKey === undefined
					? {}
					: { sessionKey: backendOptions.sessionKey }),
			});
		},
		retireSession: async (sessionKey) => {
			const agentScopes = agentScopesBySessionKey.get(sessionKey);
			if (agentScopes === undefined) {
				return;
			}
			agentScopesBySessionKey.delete(sessionKey);
			await Promise.all(
				[...agentScopes.values()].map(async ({ agentId, portalAgentScopeSource }) => {
					await core.invalidateSession(
						core.createAgentScope({
							agentId,
							agentScopeId: `mcp-provider:${agentId}`,
							sessionKey,
							source: portalAgentScopeSource,
						}),
					);
				}),
			);
		},
	};
}

export function createMcpProviderCapabilityBackend(
	props: CreateMcpProviderCapabilityBackendProps,
): McpProviderCapabilityBackend {
	const projection = ToolPortalMcpProjectionSchema.parse(props.projection);
	const scope = props.core.createAgentScope({
		agentId: projection.agentId,
		agentScopeId: `mcp-provider:${projection.agentId}`,
		...(props.sessionKey === undefined ? {} : { sessionKey: props.sessionKey }),
		source: props.portalAgentScopeSource ?? 'openclaw-trusted',
	});
	const owningGeneration = props.sessionKey ?? `mcp-provider:${projection.agentId}`;

	return {
		async call(request, options): Promise<PortalCallResult> {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			const operationIdsByCallId = operationIdsForCalls({
				calls: parsedRequest.calls,
				suppliedOperationIdsByCallId: options?.operationIdsByCallId,
			});
			const preflightItems = new Map<string, PortalCallResult['items'][number]>();
			const executableCalls: (typeof parsedRequest.calls)[number][] = [];
			for (const callRequest of parsedRequest.calls) {
				const decision = preflightCallDecision(projection, {
					namespace: callRequest.namespace,
					toolName: callRequest.name,
				});
				if (decision.kind === 'allow') {
					executableCalls.push(callRequest);
					continue;
				}
				preflightItems.set(
					callRequest.id,
					errorItem({
						code: decision.code,
						id: callRequest.id,
						namespace: callRequest.namespace,
						name: callRequest.name,
						operationId: operationIdsByCallId.get(callRequest.id) ?? randomUUID(),
						owningGeneration,
						disposition: 'not-dispatched',
					}),
				);
			}

			const coreItems = new Map<string, PortalCallResult['items'][number]>();
			const diagnostics: SafeDiagnostic[] = [];
			if (executableCalls.length > 0) {
				const callEvidence = await callCoreWithDispatchEvidence({
					core: props.core,
					input: {
						calls: executableCalls.map((callRequest) => ({
							arguments: callRequest.arguments,
							id: callRequest.id,
							namespace: callRequest.namespace,
							toolName: callRequest.name,
						})),
					},
					...(options?.signal !== undefined ? { signal: options.signal } : {}),
					scope,
					toolName: 'mcp_portal_call',
				});
				const normalizedCoreResult = normalizeCoreItemResult({
					coreResult: callEvidence.coreResult,
					dispatchedRequestIds: callEvidence.dispatchedRequestIds,
					operationIdsByCallId,
					owningGeneration,
					projection,
				});
				for (const item of normalizedCoreResult.items) {
					coreItems.set(item.id, item);
				}
				diagnostics.push(...safeDiagnosticsFromCoreResult(callEvidence.coreResult, projection));
			}

			return PortalCallResultSchema.parse({
				...(diagnostics.length > 0 ? { diagnostics } : {}),
				items: parsedRequest.calls.map(
					(callRequest) =>
						preflightItems.get(callRequest.id) ??
						coreItems.get(callRequest.id) ??
						errorItem({
							code: 'execution_failed',
							id: callRequest.id,
							namespace: callRequest.namespace,
							name: callRequest.name,
							operationId: operationIdsByCallId.get(callRequest.id) ?? randomUUID(),
							owningGeneration,
							disposition: 'ambiguous',
						}),
				),
				ok: parsedRequest.calls.every((callRequest) => {
					const item = preflightItems.get(callRequest.id) ?? coreItems.get(callRequest.id);
					return item?.status === 'ok';
				}),
			});
		},
		async describe(request, options): Promise<PortalBackendDescribeResult> {
			const parsedRequest = PortalDescribeRequestSchema.parse(request);
			const projectedRequest = {
				requests: parsedRequest.requests.map((itemRequest) => {
					const projectedItemRequest: Record<string, unknown> = {
						id: itemRequest.id,
						includeJsonSchema: itemRequest.includeJsonSchema,
						includeRelated: itemRequest.includeRelated,
						includeTypescriptHelper: itemRequest.includeTypescriptHelper,
						includeZod: itemRequest.includeZod,
					};
					if (itemRequest.refs !== undefined) {
						projectedItemRequest.refs = itemRequest.refs;
					}
					if (itemRequest.tools !== undefined) {
						projectedItemRequest.tools = itemRequest.tools
							.filter((tool) =>
								capabilityVisible(projection, {
									namespace: tool.namespace,
									toolName: tool.name,
								}),
							)
							.map((tool) => ({
								namespace: tool.namespace,
								toolName: tool.name,
							}));
					}
					return projectedItemRequest;
				}),
			};
			const coreResult = await callCore({
				core: props.core,
				input: projectedRequest,
				...(options?.signal !== undefined ? { signal: options.signal } : {}),
				scope,
				toolName: 'mcp_portal_describe',
			});
			return PortalBackendDescribeResultSchema.parse(
				normalizeScalarBatchResult(coreResult, projection),
			);
		},
		async list(request, options): Promise<PortalBackendListResult> {
			const parsedRequest = PortalListRequestSchema.parse(request);
			const projectedBatch = projectNamespaceFilteredRequests({
				emptyValue: { namespaces: [], tools: [] },
				projection,
				requests: parsedRequest.requests,
			});
			const coreResult = await callCoreWhenNeeded({
				core: props.core,
				input: { requests: projectedBatch.projectedRequests },
				...(options?.signal !== undefined ? { signal: options.signal } : {}),
				scope,
				toolName: 'mcp_portal_list',
			});
			return PortalBackendListResultSchema.parse(
				mergeScalarBatchResult({
					coreResult,
					preflightItems: projectedBatch.preflightItems,
					requestIds: parsedRequest.requests.map((itemRequest) => itemRequest.id),
					projection,
				}),
			);
		},
		async search(request, options): Promise<PortalBackendSearchResult> {
			const parsedRequest = PortalSearchRequestSchema.parse(request);
			const projectedBatch = projectNamespaceFilteredRequests({
				emptyValue: { tools: [] },
				projection,
				requests: parsedRequest.requests,
			});
			const coreResult = await callCoreWhenNeeded({
				core: props.core,
				input: { requests: projectedBatch.projectedRequests },
				...(options?.signal !== undefined ? { signal: options.signal } : {}),
				scope,
				toolName: 'mcp_portal_search',
			});
			return PortalBackendSearchResultSchema.parse(
				mergeScalarBatchResult({
					coreResult,
					preflightItems: projectedBatch.preflightItems,
					requestIds: parsedRequest.requests.map((itemRequest) => itemRequest.id),
					projection,
				}),
			);
		},
	};
}

async function callCore(props: {
	readonly core: PortalCore;
	readonly input: unknown;
	readonly scope: Parameters<PortalCore['callStream']>[0]['scope'];
	readonly signal?: AbortSignal;
	readonly toolName: PortalCoreToolName;
}): Promise<PortalCoreResult> {
	return await props.core.collectPortalCoreResult(
		props.core.callStream({
			input: props.input,
			...(props.signal !== undefined ? { signal: props.signal } : {}),
			scope: props.scope,
			toolName: props.toolName,
		}),
	);
}

async function callCoreWithDispatchEvidence(props: {
	readonly core: PortalCore;
	readonly input: unknown;
	readonly scope: Parameters<PortalCore['callStream']>[0]['scope'];
	readonly signal?: AbortSignal;
	readonly toolName: PortalCoreToolName;
}): Promise<{
	readonly coreResult: PortalCoreResult;
	readonly dispatchedRequestIds: ReadonlySet<string>;
}> {
	const dispatchedRequestIds = new Set<string>();
	const sourceEvents = props.core.callStream({
		input: props.input,
		...(props.signal !== undefined ? { signal: props.signal } : {}),
		scope: props.scope,
		toolName: props.toolName,
	});
	const observedEvents = async function* (): AsyncIterable<PortalCoreEvent> {
		for await (const event of sourceEvents) {
			if (event.kind === 'item_started') {
				dispatchedRequestIds.add(event.requestId);
			}
			yield event;
		}
	};
	const coreResult = await props.core.collectPortalCoreResult(observedEvents());
	return { coreResult, dispatchedRequestIds };
}

async function callCoreWhenNeeded(props: {
	readonly core: PortalCore;
	readonly input: { readonly requests: readonly unknown[] };
	readonly scope: Parameters<PortalCore['callStream']>[0]['scope'];
	readonly signal?: AbortSignal;
	readonly toolName: PortalCoreToolName;
}): Promise<PortalCoreResult | null> {
	if (props.input.requests.length === 0) {
		return null;
	}
	return await callCore(props);
}

function projectedNamespaces(
	projection: ToolPortalMcpProjection,
	requestedNamespaces: readonly string[] | undefined,
): readonly string[] {
	const allowedNamespaces = Object.keys(projection.namespaces);
	if (requestedNamespaces === undefined || requestedNamespaces.length === 0) {
		return allowedNamespaces;
	}
	const requestedNamespaceSet = new Set(requestedNamespaces);
	return allowedNamespaces.filter((namespace) => requestedNamespaceSet.has(namespace));
}

function projectNamespaceFilteredRequests<
	TRequest extends { readonly id: string; readonly namespaces?: readonly string[] | undefined },
>(props: {
	readonly emptyValue: JsonValue;
	readonly projection: ToolPortalMcpProjection;
	readonly requests: readonly TRequest[];
}): {
	readonly preflightItems: Map<string, NormalizedScalarPortalItem>;
	readonly projectedRequests: readonly TRequest[];
} {
	const preflightItems = new Map<string, NormalizedScalarPortalItem>();
	const projectedRequests: TRequest[] = [];
	for (const request of props.requests) {
		const namespaces = projectedNamespaces(props.projection, request.namespaces);
		if (
			request.namespaces !== undefined &&
			request.namespaces.length > 0 &&
			namespaces.length === 0
		) {
			preflightItems.set(request.id, {
				id: request.id,
				status: 'ok',
				value: props.emptyValue,
			});
			continue;
		}
		projectedRequests.push(Object.assign({}, request, { namespaces }) as TRequest);
	}
	return { preflightItems, projectedRequests };
}

function selectorIncludesTool(selector: ToolPortalToolSelector, toolName: string): boolean {
	if (selector.deny.includes(toolName)) {
		return false;
	}
	return selector.allow === '*' || selector.allow.includes(toolName);
}

function capabilityVisible(
	projection: ToolPortalMcpProjection,
	capability: { readonly namespace: string; readonly toolName: string },
): boolean {
	const namespaceProjection = projection.namespaces[capability.namespace];
	return (
		namespaceProjection !== undefined &&
		selectorIncludesTool(namespaceProjection.tools, capability.toolName)
	);
}

function preflightCallDecision(
	projection: ToolPortalMcpProjection,
	capability: { readonly namespace: string; readonly toolName: string },
): PreflightCallDecision {
	const namespaceProjection = projection.namespaces[capability.namespace];
	if (
		namespaceProjection === undefined ||
		!selectorIncludesTool(namespaceProjection.tools, capability.toolName)
	) {
		return { code: 'capability_denied', kind: 'error' };
	}
	if (selectorIncludesTool(namespaceProjection.calls.withoutApproval, capability.toolName)) {
		return { kind: 'allow' };
	}
	if (selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.toolName)) {
		return { code: 'approval_required', kind: 'error' };
	}
	return { code: 'capability_denied', kind: 'error' };
}

interface McpToolRecord extends Readonly<Record<string, unknown>> {
	readonly namespace: string;
	readonly toolName: string;
}

function isMcpToolRecord(value: unknown): value is McpToolRecord {
	return (
		isRecord(value) && typeof value.namespace === 'string' && typeof value.toolName === 'string'
	);
}

function publicToolRecordFromMcpToolRecord(tool: McpToolRecord): Readonly<Record<string, unknown>> {
	const publicToolRecord: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(tool)) {
		if (key !== 'toolName') {
			publicToolRecord[key] = value;
		}
	}
	publicToolRecord.name = tool.toolName;
	return publicToolRecord;
}

function normalizeScalarBatchResult(
	coreResult: PortalCoreResult | null,
	projection: ToolPortalMcpProjection,
): NormalizedScalarPortalResult {
	if (coreResult === null) {
		return { items: [], ok: true };
	}
	const batchResult = portalBatchResultFromStructuredContent(coreResult.structuredContent);
	const items = Object.entries(batchResult.results).map(([id, itemResult]) =>
		normalizePortalToolResultItem(id, itemResult, projection),
	);
	return {
		diagnostics: safeDiagnosticsFromCoreResult(coreResult, projection),
		items,
		ok: batchResult.ok && items.every((item) => item.status === 'ok'),
	};
}

function normalizeCoreItemResult(props: {
	readonly coreResult: PortalCoreResult;
	readonly dispatchedRequestIds: ReadonlySet<string>;
	readonly operationIdsByCallId: ReadonlyMap<string, string>;
	readonly owningGeneration: string;
	readonly projection: ToolPortalMcpProjection;
}): PortalCallResult {
	return PortalCallResultSchema.parse({
		items: props.coreResult.items.map((item) => {
			const operationId = props.operationIdsByCallId.get(item.requestId) ?? randomUUID();
			if (item.status === 'success') {
				return {
					id: item.requestId,
					operationId,
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: props.owningGeneration,
					status: 'ok',
					value: isRecord(item.structuredContent)
						? filterProjectedCapabilityValues(item.structuredContent, props.projection)
						: jsonValueFromUnknown(item.structuredContent ?? item.content),
				};
			}
			return {
				error: portalErrorFromUnknown(item.error),
				id: item.requestId,
				operationId,
				outcome: props.dispatchedRequestIds.has(item.requestId)
					? {
							certainty: 'side-effects-and-termination-unknown',
							kind: 'ambiguous',
							retryClass: 'forbidden',
						}
					: {
							certainty: 'proven',
							kind: 'not-dispatched',
							retryClass: 'safe-before-dispatch',
						},
				owningGeneration: props.owningGeneration,
				status: 'error',
			};
		}),
		ok: props.coreResult.items.every((item) => item.status === 'success'),
	});
}

function mergeScalarBatchResult(props: {
	readonly coreResult: PortalCoreResult | null;
	readonly preflightItems: Map<string, NormalizedScalarPortalItem>;
	readonly projection: ToolPortalMcpProjection;
	readonly requestIds: readonly string[];
}): NormalizedScalarPortalResult {
	const normalizedCoreResult = normalizeScalarBatchResult(props.coreResult, props.projection);
	const coreItems = new Map(normalizedCoreResult.items.map((item) => [item.id, item]));
	const items = props.requestIds
		.map((requestId) => props.preflightItems.get(requestId) ?? coreItems.get(requestId))
		.filter((item): item is NormalizedScalarPortalItem => item !== undefined);
	return {
		...(normalizedCoreResult.diagnostics !== undefined
			? { diagnostics: normalizedCoreResult.diagnostics }
			: {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	};
}

function normalizePortalToolResultItem(
	id: string,
	result: PortalToolResult,
	projection: ToolPortalMcpProjection,
): NormalizedScalarPortalItem {
	if (!result.ok) {
		return {
			error: portalErrorFromUnknown(result.error),
			id,
			status: 'error',
		};
	}
	return {
		id,
		status: 'ok',
		value: filterProjectedCapabilityValues(result.output, projection),
	};
}

function portalBatchResultFromStructuredContent(value: unknown): PortalBatchResult {
	if (!isPortalBatchResult(value)) {
		throw new Error('MCP Portal core scalar result did not contain a batch result.');
	}
	return value;
}

function isPortalBatchResult(value: unknown): value is PortalBatchResult {
	return (
		isRecord(value) &&
		Array.isArray(value.diagnostics) &&
		Array.isArray(value.errors) &&
		typeof value.ok === 'boolean' &&
		isPortalToolResultMap(value.results)
	);
}

function isPortalToolResultMap(
	value: unknown,
): value is Readonly<Record<string, PortalToolResult>> {
	return isRecord(value) && Object.values(value).every(isPortalToolResult);
}

function isPortalToolResult(value: unknown): value is PortalToolResult {
	if (!isRecord(value) || !isRecord(value.input) || typeof value.ok !== 'boolean') {
		return false;
	}
	if (value.ok) {
		return isRecord(value.output);
	}
	return Object.hasOwn(value, 'error');
}

function filterProjectedCapabilityValues(
	value: Readonly<Record<string, unknown>>,
	projection: ToolPortalMcpProjection,
): JsonValue {
	if (isMcpToolRecord(value)) {
		return jsonValueFromUnknown(publicToolRecordFromMcpToolRecord(value));
	}
	const tools = value.tools;
	if (!Array.isArray(tools)) {
		return jsonValueFromUnknown(value);
	}
	const filteredTools = tools.filter((tool): tool is McpToolRecord => {
		if (!isMcpToolRecord(tool)) {
			return false;
		}
		return capabilityVisible(projection, {
			namespace: tool.namespace,
			toolName: tool.toolName,
		});
	});
	return jsonValueFromUnknown({
		...value,
		...(Array.isArray(value.namespaces)
			? {
					namespaces: [
						...new Set(
							filteredTools
								.map((tool) => (isRecord(tool) ? tool.namespace : undefined))
								.filter((namespace): namespace is string => typeof namespace === 'string'),
						),
					].toSorted(),
				}
			: {}),
		tools: filteredTools.map(publicToolRecordFromMcpToolRecord),
	});
}

function errorItem(props: {
	readonly code: 'approval_required' | 'capability_denied' | 'execution_failed';
	readonly disposition: 'ambiguous' | 'not-dispatched';
	readonly id: string;
	readonly name: string;
	readonly namespace: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallResult['items'][number] {
	return {
		error: {
			code: props.code,
			message:
				props.code === 'approval_required'
					? `Ask operator to approve ${props.namespace}.${props.name}.`
					: props.code === 'capability_denied'
						? `Capability ${props.namespace}.${props.name} is not allowed.`
						: `Capability ${props.namespace}.${props.name} did not return a result.`,
			safeDiagnostic: safeDiagnosticForCode(props.code),
		},
		id: props.id,
		operationId: props.operationId,
		outcome:
			props.disposition === 'not-dispatched'
				? {
						certainty: 'proven',
						kind: 'not-dispatched',
						retryClass: 'safe-before-dispatch',
					}
				: {
						certainty: 'side-effects-and-termination-unknown',
						kind: 'ambiguous',
						retryClass: 'forbidden',
					},
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

function safeDiagnosticsFromCoreResult(
	coreResult: PortalCoreResult,
	projection: ToolPortalMcpProjection,
): readonly SafeDiagnostic[] {
	return (coreResult.auditEvents ?? [])
		.filter(
			(auditEvent) =>
				auditEvent.namespace === undefined ||
				projection.namespaces[auditEvent.namespace] !== undefined,
		)
		.map((auditEvent) => safeDiagnosticFromAuditEvent(auditEvent));
}

function safeDiagnosticFromAuditEvent(auditEvent: PortalBatchDiagnostic): SafeDiagnostic {
	const diagnostic = safeDiagnosticForCode(auditEvent.kind);
	return {
		...diagnostic,
		level: auditEvent.kind.includes('failed') ? 'warn' : diagnostic.level,
		...(auditEvent.namespace !== undefined
			? { safeParams: { namespace: auditEvent.namespace } }
			: {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonValueFromUnknown(value: unknown): JsonValue {
	return JsonValueSchema.parse(sanitizeModelVisibleValue(value));
}

function sanitizeModelVisibleValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.replace(/mcp_portal_(?:call|describe|list|search)/gu, 'portal capability');
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeModelVisibleValue(item));
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !isHiddenControlFieldName(key))
			.map(([key, childValue]) => [key, sanitizeModelVisibleValue(childValue)]),
	);
}

function isHiddenControlFieldName(key: string): boolean {
	return (
		key === 'approvalToken' ||
		key === 'backendKind' ||
		key === 'executionFingerprint' ||
		key === 'portalApprovalToken' ||
		key === 'transport' ||
		key === 'upstream'
	);
}
