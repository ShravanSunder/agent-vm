import {
	PortalCallRequestSchema,
	type PortalCallResult,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	JsonValueSchema,
	type PortalError,
	type PortalErrorCode,
	type SafeDiagnostic,
	type JsonValue,
} from '@agent-vm/agent-portal-sdk';
import {
	type ToolPortalMcpProjection,
	ToolPortalMcpProjectionSchema,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';

import type {
	PortalBatchDiagnostic,
	PortalBatchResult,
	PortalCore,
	PortalCoreResult,
	PortalCoreToolName,
	PortalToolResult,
} from '../core/index.js';

export interface McpProviderCapabilityBackendCallOptions {
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
	) => Promise<PortalCallResult>;
	readonly list: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalCallResult>;
	readonly search: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalCallResult>;
}

export interface CreateMcpProviderCapabilityBackendProps {
	readonly core: PortalCore;
	readonly projection: ToolPortalMcpProjection;
}

type PreflightCallDecision =
	| { readonly kind: 'allow' }
	| { readonly code: 'approval_required' | 'capability_denied'; readonly kind: 'error' };

export function createMcpProviderCapabilityBackend(
	props: CreateMcpProviderCapabilityBackendProps,
): McpProviderCapabilityBackend {
	const projection = ToolPortalMcpProjectionSchema.parse(props.projection);
	const scope = props.core.createAgentScope({
		agentId: projection.agentId,
		agentScopeId: `mcp-provider:${projection.agentId}`,
		source: 'openclaw-trusted',
	});

	return {
		async call(request, options): Promise<PortalCallResult> {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			const preflightItems = new Map<string, PortalCallResult['items'][number]>();
			const executableCalls: Array<(typeof parsedRequest.calls)[number]> = [];
			for (const callRequest of parsedRequest.calls) {
				const decision = preflightCallDecision(projection, {
					namespace: callRequest.namespace,
					toolName: callRequest.toolName,
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
						toolName: callRequest.toolName,
					}),
				);
			}

			const coreItems = new Map<string, PortalCallResult['items'][number]>();
			const diagnostics: SafeDiagnostic[] = [];
			if (executableCalls.length > 0) {
				const coreResult = await callCore({
					core: props.core,
					input: { calls: executableCalls },
					...(options?.signal !== undefined ? { signal: options.signal } : {}),
					scope,
					toolName: 'mcp_portal_call',
				});
				const normalizedCoreResult = normalizeCoreItemResult(coreResult);
				for (const item of normalizedCoreResult.items) {
					coreItems.set(item.id, item);
				}
				diagnostics.push(...safeDiagnosticsFromCoreResult(coreResult, projection));
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
							toolName: callRequest.toolName,
						}),
				),
				ok: parsedRequest.calls.every((callRequest) => {
					const item = preflightItems.get(callRequest.id) ?? coreItems.get(callRequest.id);
					return item?.status === 'ok';
				}),
			});
		},
		async describe(request, options): Promise<PortalCallResult> {
			const parsedRequest = PortalDescribeRequestSchema.parse(request);
			const projectedRequest = {
				requests: parsedRequest.requests.map((itemRequest) => ({
					...itemRequest,
					...(itemRequest.tools === undefined
						? {}
						: {
								tools: itemRequest.tools.filter((tool) => capabilityVisible(projection, tool)),
							}),
				})),
			};
			const coreResult = await callCore({
				core: props.core,
				input: projectedRequest,
				...(options?.signal !== undefined ? { signal: options.signal } : {}),
				scope,
				toolName: 'mcp_portal_describe',
			});
			return PortalDescribeResultSchema.parse(normalizeScalarBatchResult(coreResult, projection));
		},
		async list(request, options): Promise<PortalCallResult> {
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
			return PortalListResultSchema.parse(
				mergeScalarBatchResult({
					coreResult,
					preflightItems: projectedBatch.preflightItems,
					requestIds: parsedRequest.requests.map((itemRequest) => itemRequest.id),
					projection,
				}),
			);
		},
		async search(request, options): Promise<PortalCallResult> {
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
			return PortalSearchResultSchema.parse(
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
	readonly preflightItems: Map<string, PortalCallResult['items'][number]>;
	readonly projectedRequests: readonly TRequest[];
} {
	const preflightItems = new Map<string, PortalCallResult['items'][number]>();
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

function normalizeScalarBatchResult(
	coreResult: PortalCoreResult | null,
	projection: ToolPortalMcpProjection,
): PortalCallResult {
	if (coreResult === null) {
		return PortalCallResultSchema.parse({ items: [], ok: true });
	}
	const batchResult = portalBatchResultFromStructuredContent(coreResult.structuredContent);
	const items = Object.entries(batchResult.results).map(([id, itemResult]) =>
		normalizePortalToolResultItem(id, itemResult, projection),
	);
	return PortalCallResultSchema.parse({
		diagnostics: safeDiagnosticsFromCoreResult(coreResult, projection),
		items,
		ok: batchResult.ok && items.every((item) => item.status === 'ok'),
	});
}

function normalizeCoreItemResult(coreResult: PortalCoreResult): PortalCallResult {
	return PortalCallResultSchema.parse({
		items: coreResult.items.map((item) => {
			if (item.status === 'success') {
				return {
					id: item.requestId,
					status: 'ok',
					value: jsonValueFromUnknown(item.structuredContent ?? item.content),
				};
			}
			return {
				error: portalErrorFromUnknown(item.error),
				id: item.requestId,
				status: 'error',
			};
		}),
		ok: coreResult.items.every((item) => item.status === 'success'),
	});
}

function mergeScalarBatchResult(props: {
	readonly coreResult: PortalCoreResult | null;
	readonly preflightItems: Map<string, PortalCallResult['items'][number]>;
	readonly projection: ToolPortalMcpProjection;
	readonly requestIds: readonly string[];
}): PortalCallResult {
	const normalizedCoreResult = normalizeScalarBatchResult(props.coreResult, props.projection);
	const coreItems = new Map(normalizedCoreResult.items.map((item) => [item.id, item]));
	const items = props.requestIds
		.map((requestId) => props.preflightItems.get(requestId) ?? coreItems.get(requestId))
		.filter((item): item is PortalCallResult['items'][number] => item !== undefined);
	return PortalCallResultSchema.parse({
		...(normalizedCoreResult.diagnostics !== undefined
			? { diagnostics: normalizedCoreResult.diagnostics }
			: {}),
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}

function normalizePortalToolResultItem(
	id: string,
	result: PortalToolResult,
	projection: ToolPortalMcpProjection,
): PortalCallResult['items'][number] {
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
	if (!isRecord(value) || !isRecord(value.results)) {
		throw new Error('MCP Portal core scalar result did not contain a batch result.');
	}
	return value as unknown as PortalBatchResult;
}

function filterProjectedCapabilityValues(
	value: Readonly<Record<string, unknown>>,
	projection: ToolPortalMcpProjection,
): JsonValue {
	const tools = value.tools;
	if (!Array.isArray(tools)) {
		return jsonValueFromUnknown(value);
	}
	const filteredTools = tools.filter((tool) => {
		if (
			!isRecord(tool) ||
			typeof tool.namespace !== 'string' ||
			typeof tool.toolName !== 'string'
		) {
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
		tools: filteredTools,
	});
}

function errorItem(props: {
	readonly code: 'approval_required' | 'capability_denied' | 'execution_failed';
	readonly id: string;
	readonly namespace: string;
	readonly toolName: string;
}): PortalCallResult['items'][number] {
	return {
		error: {
			code: props.code,
			message:
				props.code === 'approval_required'
					? `Ask operator to approve ${props.namespace}.${props.toolName}.`
					: props.code === 'capability_denied'
						? `Capability ${props.namespace}.${props.toolName} is not allowed.`
						: `Capability ${props.namespace}.${props.toolName} did not return a result.`,
			safeDiagnostic: safeDiagnosticForCode(props.code),
		},
		id: props.id,
		status: 'error',
	};
}

function portalErrorFromUnknown(error: unknown): PortalError {
	const errorRecord = isRecord(error) ? error : {};
	const codeValue = errorRecord.code ?? errorRecord.kind;
	const code = typeof codeValue === 'string' ? safeCode(codeValue) : 'execution_failed';
	return {
		code,
		message: safeErrorMessageForCode(code),
		safeDiagnostic: safeDiagnosticForCode(code),
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

function safeDiagnosticForCode(code: string): SafeDiagnostic {
	const diagnosticCode = safeDiagnosticCode(code);
	return {
		code: diagnosticCode,
		level: diagnosticCode === 'approval_required' ? 'warn' : 'error',
		safeMessage: safeErrorMessageForCode(diagnosticCode),
	};
}

function safeErrorMessageForCode(code: string): string {
	const diagnosticCode = safeDiagnosticCode(code);
	if (diagnosticCode === 'approval_required') {
		return 'Operator approval is required.';
	}
	if (diagnosticCode === 'capability_denied') {
		return 'Requested capability is not allowed.';
	}
	if (diagnosticCode === 'validation_failed') {
		return 'Capability input did not match the expected schema.';
	}
	if (diagnosticCode === 'provider_unavailable') {
		return 'Capability provider is unavailable.';
	}
	if (diagnosticCode === 'timeout') {
		return 'Capability execution timed out.';
	}
	if (diagnosticCode === 'cancelled') {
		return 'Capability execution was cancelled.';
	}
	return 'Capability execution failed.';
}

function safeDiagnosticCode(code: string): SafeDiagnostic['code'] {
	if (code === 'approval_required') {
		return 'approval_required';
	}
	if (
		code === 'capability_denied' ||
		code === 'unknown_or_denied_tool' ||
		code === 'call_blocked'
	) {
		return 'capability_denied';
	}
	if (code === 'invalid_portal_input' || code === 'validation_failed') {
		return 'validation_failed';
	}
	if (code === 'timeout') {
		return 'timeout';
	}
	if (code === 'cancelled') {
		return 'cancelled';
	}
	if (code === 'upstream_discovery_failed' || code === 'upstream_mcp_failed') {
		return 'provider_unavailable';
	}
	return 'execution_failed';
}

function safeCode(code: string): PortalErrorCode {
	if (
		code === 'invalid_request' ||
		code === 'not_found' ||
		code === 'not_authorized' ||
		code === 'approval_required' ||
		code === 'capability_denied' ||
		code === 'validation_failed' ||
		code === 'provider_unavailable' ||
		code === 'execution_failed' ||
		code === 'cancelled' ||
		code === 'timeout'
	) {
		return code;
	}
	const diagnosticCode = safeDiagnosticCode(code);
	if (
		diagnosticCode === 'provider_unavailable' ||
		diagnosticCode === 'capability_denied' ||
		diagnosticCode === 'approval_required' ||
		diagnosticCode === 'validation_failed' ||
		diagnosticCode === 'execution_failed' ||
		diagnosticCode === 'timeout' ||
		diagnosticCode === 'cancelled'
	) {
		return diagnosticCode;
	}
	return 'execution_failed';
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
