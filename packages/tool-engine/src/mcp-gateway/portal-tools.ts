import type {
	PortalAgentIdentity,
	PortalToolSelector,
} from '@agent-collaboration/tool-access/authorization';
import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';

import type { PortalToolRecord } from '#mcp-gateway/catalog-types';
import type { PortalCallAuthorization } from '#mcp-gateway/gateway-approval';
import { validatePortalToolArguments } from '#mcp-gateway/portal-call-validation';
import type { PortalSession, PortalDiscoveryFailure } from '#mcp-gateway/portal-session';
import {
	listInputSchema,
	searchInputSchema,
	describeInputSchema,
	callExecutionInputSchema,
	type PortalToolRuntime,
	type PortalBatchResult,
	type PortalToolResult,
	type PortalToolResultMap,
	type PortalBatchDiagnostic,
	type PortalToolHandlers,
	type PortalBatchError,
	type PortalToolHandlerCall,
	type PortalSafeTransportDiagnostic,
	type SelectorInputResult,
	type ExactFilterResult,
	type PreparedPortalCall,
	type CallRequest,
	type ListRequest,
	type SearchRequest,
	type DescribeRequest,
} from '#mcp-gateway/portal-tool-contracts';
import type { ToolSearchResult } from '#mcp-gateway/search-index';
import { decodeToolRef } from '#mcp-gateway/tool-ref';
import {
	createToolSummary,
	type ToolSummary,
	type ToolSchemaHint,
} from '#mcp-gateway/tool-summary';
import { generateTypescriptCatalogArtifact } from '#mcp-gateway/typescript-artifact';
export { portalToolInputSchemas } from '#mcp-gateway/portal-tool-contracts';
export type * from '#mcp-gateway/portal-tool-contracts';
const describeBeforeCallSchemaHint = {
	message: 'Use mcp_portal_describe for exact input schema before calling.',
	next: 'describe_before_call',
} as const satisfies ToolSchemaHint;

const callReadySchemaHint = {
	message: 'Full input schema included.',
	next: 'call_ready',
} as const satisfies ToolSchemaHint;

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeTransportDiagnosticFromUnknown(
	transport: unknown,
): PortalSafeTransportDiagnostic | undefined {
	if (typeof transport !== 'object' || transport === null || Array.isArray(transport)) {
		return undefined;
	}
	if (!('kind' in transport)) {
		return undefined;
	}
	const kind = transport.kind;
	return typeof kind === 'string' ? { kind } : undefined;
}

function safeUpstreamMcpCauseMessage(): string {
	return 'Upstream MCP provider failed.';
}

function safeDiscoveryDiagnosticMessage(failure: PortalDiscoveryFailure): string {
	if (failure.kind !== 'upstream_mcp_failed') {
		return 'MCP provider discovery failed.';
	}
	return `${failure.namespace}: ${failure.phase ?? 'discovery'} failed`;
}

function invalidPortalInput(error: unknown): PortalBatchResult {
	return {
		diagnostics: [],
		errors: [{ kind: 'invalid_portal_input', message: messageFromError(error) }],
		ok: false,
		results: {},
	};
}

function itemError(props: {
	readonly error: unknown;
	readonly input: Readonly<Record<string, unknown>>;
}): PortalToolResult {
	return {
		error: props.error,
		input: props.input,
		ok: false,
	};
}

function itemOutput(props: {
	readonly input: Readonly<Record<string, unknown>>;
	readonly output: Readonly<Record<string, unknown>>;
}): PortalToolResult {
	return {
		input: props.input,
		ok: true,
		output: props.output,
	};
}

function discoveryDiagnostics(session: PortalSession): readonly PortalBatchDiagnostic[] {
	return session.catalog.discoveryFailures.map((failure) => {
		const safeTransport = safeTransportDiagnosticFromUnknown(failure.transport);
		const isUpstreamMcpFailure = failure.kind === 'upstream_mcp_failed';
		return {
			...(failure.causeMessage === undefined || !isUpstreamMcpFailure
				? {}
				: { causeMessage: safeUpstreamMcpCauseMessage() }),
			...(failure.elapsedMs === undefined ? {} : { elapsedMs: failure.elapsedMs }),
			...(failure.hint === undefined ? {} : { hint: failure.hint }),
			kind: isUpstreamMcpFailure ? 'upstream_mcp_failed' : 'upstream_discovery_failed',
			message: safeDiscoveryDiagnosticMessage(failure),
			namespace: failure.namespace,
			...(failure.operation === undefined ? {} : { operation: failure.operation }),
			...(failure.phase === undefined ? {} : { phase: failure.phase }),
			...(failure.timeoutMs === undefined ? {} : { timeoutMs: failure.timeoutMs }),
			...(failure.toolName === undefined ? {} : { toolName: failure.toolName }),
			...(safeTransport === undefined ? {} : { transport: safeTransport }),
		};
	});
}

function portalBatchResult(
	results: PortalToolResultMap,
	diagnostics: readonly PortalBatchDiagnostic[] = [],
): PortalBatchResult {
	const allItemsOk = Object.values(results).every((result) => result.ok);
	return { diagnostics, errors: [], ok: allItemsOk, results };
}

function duplicateIdErrors(items: readonly { readonly id: string }[]): readonly PortalBatchError[] {
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	for (const item of items) {
		if (seenIds.has(item.id)) {
			duplicateIds.add(item.id);
		}
		seenIds.add(item.id);
	}

	return [...duplicateIds].toSorted().map((id) => ({
		id,
		kind: 'duplicate_id',
		message: `Duplicate portal request id "${id}". Each request id must be unique.`,
	}));
}

function duplicateIdResult(items: readonly { readonly id: string }[]): PortalBatchResult | null {
	const errors = duplicateIdErrors(items);
	return errors.length > 0 ? { diagnostics: [], errors, ok: false, results: {} } : null;
}

function findTool(session: PortalSession, selector: PortalToolSelector): PortalToolRecord | null {
	return (
		session.catalog.tools.find(
			(tool) => tool.namespace === selector.namespace && tool.toolName === selector.toolName,
		) ?? null
	);
}

function discoveryFailureForNamespace(
	session: PortalSession,
	namespace: string,
): PortalDiscoveryFailure | null {
	return (
		session.catalog.discoveryFailures.find((failure) => failure.namespace === namespace) ?? null
	);
}

function unavailableNamespaceError(props: {
	readonly failure: PortalDiscoveryFailure;
	readonly selector: PortalToolSelector;
}): Readonly<Record<string, unknown>> {
	return {
		kind: 'namespace_unavailable',
		message: `MCP namespace "${props.selector.namespace}" is disabled/unavailable: ${props.failure.message}`,
		namespace: props.selector.namespace,
		toolName: props.selector.toolName,
	};
}

function selectorsFromInput(
	tools?: readonly PortalToolSelector[],
	refs?: readonly string[],
): SelectorInputResult {
	const selectors: PortalToolSelector[] = [...(tools ?? [])];
	for (const toolRef of refs ?? []) {
		try {
			selectors.push(decodeToolRef(toolRef));
		} catch (error) {
			return {
				error: { kind: 'invalid_portal_input', message: messageFromError(error) },
				ok: false,
			};
		}
	}

	return { ok: true, selectors };
}

function applyExactFilters(
	tools: readonly PortalToolRecord[],
	filters: {
		readonly namespaces?: readonly string[];
		readonly refs?: readonly string[];
		readonly tools?: readonly PortalToolSelector[];
	},
): ExactFilterResult {
	const namespaceFilter = new Set(filters.namespaces ?? []);
	const selectorResult = selectorsFromInput(filters.tools, filters.refs);
	if (!selectorResult.ok) {
		return selectorResult;
	}
	const exactSelectors = selectorResult.selectors;
	if (exactSelectors.length === 0) {
		return {
			ok: true,
			tools: tools.filter(
				(tool) => namespaceFilter.size === 0 || namespaceFilter.has(tool.namespace),
			),
		};
	}

	return {
		ok: true,
		tools: tools.filter(
			(tool) =>
				(namespaceFilter.size === 0 || namespaceFilter.has(tool.namespace)) &&
				exactSelectors.some(
					(selector) =>
						selector.namespace === tool.namespace && selector.toolName === tool.toolName,
				),
		),
	};
}

function selectorKey(selector: PortalToolSelector): string {
	return `${selector.namespace}\n${selector.toolName}`;
}

function missingSelectorError(
	requestedSelectors: readonly PortalToolSelector[],
	selectedTools: readonly PortalToolRecord[],
): PortalBatchError | null {
	const foundKeys = new Set(
		selectedTools.map((tool) =>
			selectorKey({ namespace: tool.namespace, toolName: tool.toolName }),
		),
	);
	const missingSelectors = requestedSelectors.filter(
		(selector) => !foundKeys.has(selectorKey(selector)),
	);
	if (missingSelectors.length === 0) {
		return null;
	}

	return {
		kind: 'unknown_or_denied_tool',
		message: 'One or more requested tools are unknown or denied for this portal agent scope.',
	};
}

function paginate<TItem>(
	items: readonly TItem[],
	limit: number,
	cursor?: string,
): { readonly items: readonly TItem[]; readonly nextCursor?: string } {
	const offset = cursor ? Number.parseInt(cursor, 10) : 0;
	const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
	const page = items.slice(safeOffset, safeOffset + limit);
	const nextOffset = safeOffset + page.length;

	return {
		items: page,
		...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
	};
}

function describeToolOutput(props: {
	readonly includeJsonSchema: boolean;
	readonly includeRelated: boolean;
	readonly typescriptHelper: string | undefined;
	readonly includeZod: boolean;
	readonly session: PortalSession;
	readonly tool: PortalToolRecord;
}): Readonly<Record<string, unknown>> {
	const toolSummary = createToolSummary(props.tool);
	const result: Record<string, unknown> = {
		annotations: props.tool.annotations ?? {},
		namespace: props.tool.namespace,
		related: props.includeRelated
			? props.session.graph.relationships.filter(
					(relationship) =>
						relationship.from.toolRef === toolSummary.toolRef ||
						relationship.to.toolRef === toolSummary.toolRef,
				)
			: [],
		schemaHint: callReadySchemaHint,
		toolName: props.tool.toolName,
		toolRef: toolSummary.toolRef,
	};

	if (props.includeJsonSchema) {
		result.inputSchema = props.tool.inputSchema;
		if (props.tool.outputSchema !== undefined) {
			result.outputSchema = props.tool.outputSchema;
		}
	}
	if (props.includeZod) {
		result.zod = { experimental: true, source: 'z.fromJSONSchema(inputSchema)' };
	}
	if (typeof props.typescriptHelper === 'string') {
		result.typescriptHelper = props.typescriptHelper;
	}

	return structuredClone(result);
}

function searchOutputWithFullSchema(
	session: PortalSession,
	summary: ToolSearchResult,
): Readonly<Record<string, unknown>> {
	const tool = findTool(session, summary);
	const result: Record<string, unknown> = {
		input: summary.input,
		namespace: summary.namespace,
		safety: summary.safety,
		schemaHint: callReadySchemaHint,
		toolName: summary.toolName,
		toolRef: summary.toolRef,
	};

	if (summary.description !== undefined) {
		result.description = summary.description;
	}
	if (summary.output !== undefined) {
		result.output = summary.output;
	}
	if (summary.relationshipHints !== undefined) {
		result.relationshipHints = summary.relationshipHints;
	}
	if (summary.schemaFieldMatches !== undefined) {
		result.schemaFieldMatches = summary.schemaFieldMatches;
	}
	if (summary.title !== undefined) {
		result.title = summary.title;
	}

	if (tool) {
		result.inputSchema = tool.inputSchema;
		if (tool.outputSchema !== undefined) {
			result.outputSchema = tool.outputSchema;
		}
	}

	return structuredClone(result);
}

function toolSummaryWithSchemaHint(summary: ToolSummary): ToolSummary {
	return structuredClone(Object.assign({}, summary, { schemaHint: describeBeforeCallSchemaHint }));
}

function toolSearchResultWithSchemaHint(
	summary: ToolSearchResult,
): ToolSearchResult & { readonly schemaHint: ToolSchemaHint } {
	return structuredClone(Object.assign({}, summary, { schemaHint: describeBeforeCallSchemaHint }));
}

function listRequestResult(session: PortalSession, request: ListRequest): PortalToolResult {
	const filteredTools = applyExactFilters(session.catalog.tools, {
		...(request.namespaces !== undefined ? { namespaces: request.namespaces } : {}),
		...(request.refs !== undefined ? { refs: request.refs } : {}),
		...(request.tools !== undefined ? { tools: request.tools } : {}),
	});
	if (!filteredTools.ok) {
		return itemError({ error: filteredTools.error, input: request });
	}
	const page = paginate(
		filteredTools.tools.map((tool) => toolSummaryWithSchemaHint(createToolSummary(tool))),
		request.limit,
		request.cursor,
	);
	const output = {
		namespaces: [...new Set(filteredTools.tools.map((tool) => tool.namespace))].toSorted(),
		...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
		tools: page.items,
	} satisfies {
		readonly namespaces: readonly string[];
		readonly nextCursor?: string;
		readonly tools: readonly ToolSummary[];
	};

	return itemOutput({ input: request, output });
}

function searchRequestResult(session: PortalSession, request: SearchRequest): PortalToolResult {
	const result = session.searchIndex.search({
		limit: request.limit,
		...(request.namespaces ? { namespaces: request.namespaces } : {}),
		...(request.query !== undefined ? { query: request.query } : {}),
	});
	const tools =
		request.schemaDetail === 'full'
			? result.results.map((summary) => searchOutputWithFullSchema(session, summary))
			: result.results.map((summary) => toolSearchResultWithSchemaHint(summary));

	return itemOutput({ input: request, output: { tools } });
}

async function describeRequestResult(
	session: PortalSession,
	request: DescribeRequest,
): Promise<PortalToolResult> {
	const selectorResult = selectorsFromInput(request.tools, request.refs);
	if (!selectorResult.ok) {
		return itemError({ error: selectorResult.error, input: request });
	}
	const selectors = selectorResult.selectors;
	const selectedTools = selectors
		.map((selector) => findTool(session, selector))
		.filter((tool): tool is PortalToolRecord => tool !== null);
	const missingError = missingSelectorError(selectors, selectedTools);
	if (missingError) {
		return itemError({
			error: {
				...missingError,
				tools: selectors.filter((selector) => findTool(session, selector) === null),
			},
			input: request,
		});
	}

	const tools = await Promise.all(
		selectedTools.map(async (tool) =>
			describeToolOutput({
				includeJsonSchema: request.includeJsonSchema,
				includeRelated: request.includeRelated,
				typescriptHelper: request.includeTypescriptHelper
					? await generateTypescriptCatalogArtifact({ tools: [tool] })
					: undefined,
				includeZod: request.includeZod,
				session,
				tool,
			}),
		),
	);
	return itemOutput({ input: request, output: { tools } });
}

function preparePortalCall(
	session: PortalSession,
	request: CallRequest,
): PreparedPortalCall | PortalToolResult {
	const tool = findTool(session, request);
	if (!tool) {
		const discoveryFailure = discoveryFailureForNamespace(session, request.namespace);
		if (discoveryFailure !== null) {
			return itemError({
				error: unavailableNamespaceError({
					failure: discoveryFailure,
					selector: request,
				}),
				input: request,
			});
		}
		return itemError({
			error: {
				kind: 'unknown_or_denied_tool',
				message: 'The requested tool is unknown or denied for this portal agent scope.',
				namespace: request.namespace,
				toolName: request.toolName,
			},
			input: request,
		});
	}

	const validation = validatePortalToolArguments(tool, request.arguments);
	if (!validation.ok) {
		return itemError({ error: validation.error, input: request });
	}
	const validatedArgumentsResult = jsonObjectSchema.safeParse(validation.value);
	if (!validatedArgumentsResult.success) {
		return itemError({
			error: {
				kind: 'invalid_portal_input',
				message: validatedArgumentsResult.error.message,
			},
			input: request,
		});
	}

	return { input: request, tool, validatedArguments: validatedArgumentsResult.data };
}

async function executePreparedPortalCall(props: {
	readonly call: PreparedPortalCall;
	readonly identity: PortalAgentIdentity;
	readonly runtime: PortalToolRuntime;
	readonly authorization: PortalCallAuthorization | undefined;
}): Promise<PortalToolResult> {
	const { call, identity, runtime, authorization } = props;
	const input = { ...call.input, arguments: call.validatedArguments };
	if (authorization?.kind === 'refused')
		return itemError({
			input,
			error: { kind: 'approval_token_invalid', reason: authorization.reason },
		});
	try {
		const result = await runtime.dispatchCall({
			...(authorization?.kind === 'token-approved' ? { approval: authorization.approval } : {}),
			arguments: call.validatedArguments,
			identity,
			namespace: call.tool.namespace,
			requestId: call.input.id,
			toolName: call.tool.toolName,
		});
		return result.kind === 'completed'
			? itemOutput({
					input,
					output: {
						namespace: call.tool.namespace,
						result: result.result,
						toolName: call.tool.toolName,
					},
				})
			: itemError({
					input,
					error:
						(result.kind === 'failed' || result.kind === 'ambiguous') &&
						result.detail?.kind === 'mcp-upstream-failure'
							? {
									kind: result.detail.code,
									message: result.detail.message,
									namespace: result.detail.namespace,
									toolName: result.detail.toolName,
									upstream: result.detail.upstream,
								}
							: result,
				});
	} catch {
		return itemError({ input, error: { kind: 'ambiguous', reason: 'dispatch-unconfirmed' } });
	}
}

function isPreparedPortalCall(
	value: PreparedPortalCall | PortalToolResult,
): value is PreparedPortalCall {
	return 'validatedArguments' in value;
}

async function addExecutableCallResults(props: {
	readonly authorizations: ReadonlyMap<string, PortalCallAuthorization>;
	readonly identity: PortalAgentIdentity;
	readonly preparedCalls: readonly PreparedPortalCall[];
	readonly results: Record<string, PortalToolResult>;
	readonly runtime: PortalToolRuntime;
}): Promise<void> {
	await Promise.all(
		props.preparedCalls.map(async (preparedCall): Promise<void> => {
			props.results[preparedCall.input.id] = await executePreparedPortalCall({
				call: preparedCall,
				identity: props.identity,
				runtime: props.runtime,
				authorization: props.authorizations.get(preparedCall.input.id),
			});
		}),
	);
}

export function createPortalToolHandlers(runtime: PortalToolRuntime): PortalToolHandlers {
	return {
		async call(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = callExecutionInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.calls);
			if (duplicateResult) {
				return duplicateResult;
			}

			let session: PortalSession;
			try {
				session = await runtime.getSession(call.identity);
			} catch {
				return portalBatchResult(
					Object.fromEntries(
						parsedInput.data.calls.map((request) => [
							request.id,
							itemError({
								input: request,
								error: { kind: 'not-dispatched', reason: 'catalog-unavailable' },
							}),
						]),
					),
				);
			}
			const preparedResults = parsedInput.data.calls.map((request) =>
				(() => {
					try {
						return preparePortalCall(session, request);
					} catch {
						return itemError({
							input: request,
							error: { kind: 'not-dispatched', reason: 'preparation-failed' },
						});
					}
				})(),
			);
			const executableCalls = preparedResults.filter(isPreparedPortalCall);
			const results: Record<string, PortalToolResult> = {};
			for (const preparedResult of preparedResults) {
				if (!isPreparedPortalCall(preparedResult)) {
					const id = preparedResult.input.id;
					if (typeof id === 'string') results[id] = preparedResult;
				}
			}
			let authorizations: ReadonlyMap<string, PortalCallAuthorization>;
			try {
				authorizations =
					(await runtime.authorizeCalls?.(executableCalls, parsedInput.data.portalApprovalToken)) ??
					new Map();
			} catch {
				authorizations = new Map(
					executableCalls.map((entry) => [
						entry.input.id,
						{ kind: 'refused', reason: 'approval-unavailable' },
					]),
				);
			}
			await addExecutableCallResults({
				authorizations,
				identity: call.identity,
				preparedCalls: executableCalls,
				results,
				runtime,
			});

			return portalBatchResult(results, discoveryDiagnostics(session));
		},
		async describe(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = describeInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.requests);
			if (duplicateResult) {
				return duplicateResult;
			}

			const session = await runtime.getSession(call.identity);
			return portalBatchResult(
				Object.fromEntries(
					await Promise.all(
						parsedInput.data.requests.map(async (request) => [
							request.id,
							await describeRequestResult(session, request),
						]),
					),
				),
				discoveryDiagnostics(session),
			);
		},
		async list(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = listInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.requests);
			if (duplicateResult) {
				return duplicateResult;
			}

			const session = await runtime.getSession(call.identity);
			return portalBatchResult(
				Object.fromEntries(
					parsedInput.data.requests.map((request) => [
						request.id,
						listRequestResult(session, request),
					]),
				),
				discoveryDiagnostics(session),
			);
		},
		async search(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = searchInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.requests);
			if (duplicateResult) {
				return duplicateResult;
			}

			const session = await runtime.getSession(call.identity);
			return portalBatchResult(
				Object.fromEntries(
					parsedInput.data.requests.map((request) => [
						request.id,
						searchRequestResult(session, request),
					]),
				),
				discoveryDiagnostics(session),
			);
		},
	};
}
