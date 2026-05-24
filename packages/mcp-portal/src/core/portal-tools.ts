import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { PortalToolRecord } from '../catalog-types.js';
import { jsonObjectSchema, type JsonObject } from '../json-schema.js';
import {
	portalAgentScopeKey,
	type PortalAgentIdentity,
	type PortalToolSelector,
} from '../portal-access-policy.js';
import { generateTypescriptCatalogArtifact } from '../portal-config/typescript-artifact.js';
import type { PortalSession } from '../portal-session.js';
import type { ToolSearchResult } from '../search-index.js';
import { decodeToolRef } from '../tool-ref.js';
import { createToolSummary, type ToolSchemaHint, type ToolSummary } from '../tool-summary.js';
import { upstreamMcpFailureDetailsFromUnknown } from '../upstream-mcp-errors.js';
import { validatePortalToolArguments } from './portal-call-validation.js';

export interface PortalToolSuccess {
	readonly input: Readonly<Record<string, unknown>>;
	readonly ok: true;
	readonly output: Readonly<Record<string, unknown>>;
}

export interface PortalToolFailure {
	readonly error: unknown;
	readonly input: Readonly<Record<string, unknown>>;
	readonly ok: false;
}

export type PortalToolResult = PortalToolFailure | PortalToolSuccess;
export type PortalToolResultMap = Readonly<Record<string, PortalToolResult>>;

export interface PortalBatchError {
	readonly id?: string;
	readonly kind: string;
	readonly message: string;
}

export interface PortalBatchDiagnostic {
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

export interface PortalBatchResult {
	readonly diagnostics: readonly PortalBatchDiagnostic[];
	readonly errors: readonly PortalBatchError[];
	readonly ok: boolean;
	readonly results: PortalToolResultMap;
}

export interface PortalApprovalCall {
	readonly arguments: JsonObject;
	readonly id: string;
	readonly namespace: string;
	readonly tool: PortalToolRecord;
	readonly toolName: string;
}

type SelectorInputResult =
	| { readonly error: PortalBatchError; readonly ok: false }
	| { readonly ok: true; readonly selectors: readonly PortalToolSelector[] };
type ExactFilterResult =
	| { readonly error: PortalBatchError; readonly ok: false }
	| { readonly ok: true; readonly tools: readonly PortalToolRecord[] };

const requestIdSchema = z.string().min(1);
const reservedRequestIds = new Set(['__proto__', 'constructor', 'prototype']);
const safeRequestIdSchema = requestIdSchema.refine((id) => !reservedRequestIds.has(id), {
	message: 'Portal request id uses a reserved object property name.',
});
const namespaceToolSelectorSchema = z
	.object({ namespace: z.string().min(1), toolName: z.string().min(1) })
	.strict();
const listRequestSchema = z
	.object({
		cursor: z.string().regex(/^\d+$/u).optional(),
		id: safeRequestIdSchema,
		limit: z.number().int().positive().max(100).default(20),
		namespaces: z.array(z.string()).optional(),
		refs: z.array(z.string()).optional(),
		tools: z.array(namespaceToolSelectorSchema).optional(),
	})
	.strict();
const searchRequestSchema = z
	.object({
		id: safeRequestIdSchema,
		limit: z.number().int().positive().max(50).default(10),
		namespaces: z.array(z.string()).optional(),
		query: z.string().optional(),
		schemaDetail: z.enum(['none', 'summary', 'full']).default('summary'),
	})
	.strict();
const describeRequestSchema = z
	.object({
		id: safeRequestIdSchema,
		includeJsonSchema: z.boolean().default(true),
		includeRelated: z.boolean().default(true),
		includeTypescriptHelper: z.boolean().default(false),
		includeZod: z.boolean().default(false),
		refs: z.array(z.string()).optional(),
		tools: z.array(namespaceToolSelectorSchema).optional(),
	})
	.strict();
const callRequestSchema = z
	.object({
		arguments: jsonObjectSchema,
		id: safeRequestIdSchema,
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();
const listInputSchema = z.object({ requests: z.array(listRequestSchema).min(1) }).strict();
const searchInputSchema = z.object({ requests: z.array(searchRequestSchema).min(1) }).strict();
const describeInputSchema = z.object({ requests: z.array(describeRequestSchema).min(1) }).strict();
const callInputSchema = z.object({ calls: z.array(callRequestSchema).min(1) }).strict();
const callExecutionInputSchema = z
	.object({
		calls: z.array(callRequestSchema).min(1),
		portalApprovalToken: z.string().min(1).optional(),
	})
	.strict();

type ListRequest = z.infer<typeof listRequestSchema>;
type SearchRequest = z.infer<typeof searchRequestSchema>;
type DescribeRequest = z.infer<typeof describeRequestSchema>;
type CallRequest = z.infer<typeof callRequestSchema>;

interface PreparedPortalCall {
	readonly input: CallRequest;
	readonly validatedArguments: JsonObject;
	readonly tool: PortalToolRecord;
}

const describeBeforeCallSchemaHint = {
	message: 'Use mcp_portal_describe for exact input schema before calling.',
	next: 'describe_before_call',
} as const satisfies ToolSchemaHint;

const callReadySchemaHint = {
	message: 'Full input schema included.',
	next: 'call_ready',
} as const satisfies ToolSchemaHint;

function isToolSchemaProperties(value: unknown): value is Record<string, object> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every(
			(entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
		)
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function toPortalInputJsonSchema(schema: z.ZodType): Tool['inputSchema'] {
	const jsonSchema = jsonObjectSchema.parse(z.toJSONSchema(schema, { io: 'input' }));
	if (jsonSchema.type !== 'object') {
		throw new Error('MCP Portal tool input schemas must be JSON Schema objects.');
	}
	const properties = isToolSchemaProperties(jsonSchema.properties)
		? jsonSchema.properties
		: undefined;
	const required = isStringArray(jsonSchema.required) ? jsonSchema.required : undefined;

	return {
		...jsonSchema,
		...(properties !== undefined ? { properties } : {}),
		...(required !== undefined ? { required } : {}),
		type: 'object',
	};
}

export const portalToolInputSchemas = {
	mcp_portal_call: toPortalInputJsonSchema(callInputSchema),
	mcp_portal_describe: toPortalInputJsonSchema(describeInputSchema),
	mcp_portal_list: toPortalInputJsonSchema(listInputSchema),
	mcp_portal_search: toPortalInputJsonSchema(searchInputSchema),
} as const;

export interface PortalToolHandlerCall {
	readonly identity: PortalAgentIdentity;
	readonly input: unknown;
}

export interface PortalCallUpstreamTool {
	readonly arguments: JsonObject;
	readonly agentScopeId: string;
	readonly namespace: string;
	readonly onEvent?: (event: PortalUpstreamEvent) => Promise<void> | void;
	readonly requestId: string;
	readonly signal?: AbortSignal;
	readonly toolName: string;
}

export type PortalUpstreamEvent =
	| {
			readonly kind: 'progress';
			readonly message?: string;
			readonly progress?: number;
			readonly total?: number;
	  }
	| {
			readonly kind: 'upstream_notification';
			readonly method: string;
			readonly params: unknown;
	  }
	| {
			readonly content:
				| { readonly text: string; readonly type: 'text' }
				| { readonly type: 'json'; readonly value: unknown };
			readonly kind: 'partial_content';
	  };

export interface PortalToolRuntime {
	readonly approval?: (
		calls: readonly PortalApprovalCall[],
		identity: PortalAgentIdentity,
		approvalToken: string | undefined,
	) =>
		| { readonly kind: 'allow' }
		| { readonly kind: 'call_blocked' }
		| { readonly kind: 'approval_token_invalid'; readonly reason: string }
		| { readonly kind: 'approval_token_missing' }
		| { readonly kind: 'approval_required'; readonly level: 'critical' | 'standard' };
	readonly callUpstreamTool: (call: PortalCallUpstreamTool) => Promise<unknown>;
	readonly getSession: (identity: PortalAgentIdentity) => Promise<PortalSession>;
}

type PortalApprovalDecision =
	| { readonly kind: 'allow' }
	| { readonly kind: 'approval_configuration_missing' }
	| { readonly kind: 'approval_required'; readonly level: 'critical' | 'standard' }
	| { readonly kind: 'approval_token_invalid'; readonly reason: string }
	| { readonly kind: 'approval_token_missing' }
	| { readonly kind: 'call_blocked' };

export interface PortalToolHandlers {
	readonly call: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
	readonly describe: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
	readonly list: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
	readonly search: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	return session.catalog.discoveryFailures.map((failure) => ({
		...failure,
		kind:
			failure.kind === 'upstream_mcp_failed' ? 'upstream_mcp_failed' : 'upstream_discovery_failed',
	}));
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
	readonly includeTypescriptHelper: boolean;
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
		result.outputSchema = props.tool.outputSchema;
	}
	if (props.includeZod) {
		result.zod = { experimental: true, source: 'z.fromJSONSchema(inputSchema)' };
	}
	if (props.includeTypescriptHelper) {
		result.typescriptHelper = generateTypescriptCatalogArtifact({ tools: [props.tool] });
	}

	return result;
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
		result.outputSchema = tool.outputSchema;
	}

	return result;
}

function toolSummaryWithSchemaHint(summary: ToolSummary): ToolSummary {
	return Object.assign({}, summary, { schemaHint: describeBeforeCallSchemaHint });
}

function toolSearchResultWithSchemaHint(
	summary: ToolSearchResult,
): ToolSearchResult & { readonly schemaHint: ToolSchemaHint } {
	return Object.assign({}, summary, { schemaHint: describeBeforeCallSchemaHint });
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

function describeRequestResult(session: PortalSession, request: DescribeRequest): PortalToolResult {
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

	const tools = selectedTools.map((tool) =>
		describeToolOutput({
			includeJsonSchema: request.includeJsonSchema,
			includeRelated: request.includeRelated,
			includeTypescriptHelper: request.includeTypescriptHelper,
			includeZod: request.includeZod,
			session,
			tool,
		}),
	);
	return itemOutput({ input: request, output: { tools } });
}

function preparePortalCall(
	session: PortalSession,
	request: CallRequest,
): PreparedPortalCall | PortalToolResult {
	const tool = findTool(session, request);
	if (!tool) {
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

async function executePreparedPortalCall(
	call: PreparedPortalCall,
	identity: PortalAgentIdentity,
	runtime: PortalToolRuntime,
): Promise<PortalToolResult> {
	const input = { ...call.input, arguments: call.validatedArguments };
	try {
		return itemOutput({
			input,
			output: {
				namespace: call.tool.namespace,
				result: await runtime.callUpstreamTool({
					arguments: call.validatedArguments,
					agentScopeId: portalAgentScopeKey(identity),
					namespace: call.tool.namespace,
					requestId: call.input.id,
					toolName: call.tool.toolName,
				}),
				toolName: call.tool.toolName,
			},
		});
	} catch (error) {
		const upstream = upstreamMcpFailureDetailsFromUnknown(error);
		return itemError({
			error: {
				kind: 'upstream_call_failed',
				message: messageFromError(error),
				namespace: call.tool.namespace,
				toolName: call.tool.toolName,
				...(upstream === null ? {} : { upstream }),
			},
			input,
		});
	}
}

function isPreparedPortalCall(
	value: PreparedPortalCall | PortalToolResult,
): value is PreparedPortalCall {
	return 'validatedArguments' in value;
}

async function addExecutableCallResults(props: {
	readonly identity: PortalAgentIdentity;
	readonly preparedCalls: readonly PreparedPortalCall[];
	readonly results: Record<string, PortalToolResult>;
	readonly runtime: PortalToolRuntime;
}): Promise<void> {
	await Promise.all(
		props.preparedCalls.map(async (preparedCall): Promise<void> => {
			props.results[preparedCall.input.id] = await executePreparedPortalCall(
				preparedCall,
				props.identity,
				props.runtime,
			);
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

			const session = await runtime.getSession(call.identity);
			const preparedResults = parsedInput.data.calls.map((request) =>
				preparePortalCall(session, request),
			);
			const executableCalls = preparedResults.filter(isPreparedPortalCall);
			const approvalCalls = executableCalls.map(
				(executableCall) =>
					({
						arguments: executableCall.validatedArguments,
						id: executableCall.input.id,
						namespace: executableCall.tool.namespace,
						tool: executableCall.tool,
						toolName: executableCall.tool.toolName,
					}) satisfies PortalApprovalCall,
			);
			const allowDecision = { kind: 'allow' } satisfies PortalApprovalDecision;
			const approval: PortalApprovalDecision =
				approvalCalls.length === 0
					? allowDecision
					: (runtime.approval?.(
							approvalCalls,
							call.identity,
							parsedInput.data.portalApprovalToken,
						) ?? { kind: 'approval_configuration_missing' });

			const results: Record<string, PortalToolResult> = {};
			const callsToExecute: PreparedPortalCall[] = [];
			for (const preparedResult of preparedResults) {
				if (!isPreparedPortalCall(preparedResult)) {
					const input = preparedResult.input;
					if (typeof input === 'object' && input !== null && 'id' in input) {
						const id = input.id;
						if (typeof id === 'string') {
							results[id] = preparedResult;
						}
					}
					continue;
				}

				if (approval.kind === 'approval_required') {
					results[preparedResult.input.id] = itemError({
						error: {
							kind: 'approval_required',
							level: approval.level,
							message: 'Operator approval is required before this batch can run.',
							namespace: preparedResult.tool.namespace,
							toolName: preparedResult.tool.toolName,
						},
						input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
					});
					continue;
				}
				if (approval.kind === 'approval_token_missing') {
					results[preparedResult.input.id] = itemError({
						error: {
							kind: 'approval_token_missing',
							message: 'An MCP Portal approval token is required before this batch can run.',
							namespace: preparedResult.tool.namespace,
							toolName: preparedResult.tool.toolName,
						},
						input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
					});
					continue;
				}
				if (approval.kind === 'approval_token_invalid') {
					results[preparedResult.input.id] = itemError({
						error: {
							kind: 'approval_token_invalid',
							message: `MCP Portal approval token is invalid: ${approval.reason}.`,
							namespace: preparedResult.tool.namespace,
							reason: approval.reason,
							toolName: preparedResult.tool.toolName,
						},
						input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
					});
					continue;
				}
				if (approval.kind === 'call_blocked') {
					results[preparedResult.input.id] = itemError({
						error: {
							kind: 'call_blocked',
							message: 'MCP Portal policy does not allow this tool call.',
							namespace: preparedResult.tool.namespace,
							toolName: preparedResult.tool.toolName,
						},
						input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
					});
					continue;
				}
				if (approval.kind === 'approval_configuration_missing') {
					results[preparedResult.input.id] = itemError({
						error: {
							kind: 'approval_configuration_missing',
							message: 'MCP Portal approval evaluation is not configured.',
							namespace: preparedResult.tool.namespace,
							toolName: preparedResult.tool.toolName,
						},
						input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
					});
					continue;
				}

				callsToExecute.push(preparedResult);
			}
			await addExecutableCallResults({
				identity: call.identity,
				preparedCalls: callsToExecute,
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
					parsedInput.data.requests.map((request) => [
						request.id,
						describeRequestResult(session, request),
					]),
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
