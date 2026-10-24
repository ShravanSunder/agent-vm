import type { AgentCatalogView } from '#mcp-gateway/agent-catalog-views/models/agent-catalog-view';
import type { PortalToolRecord } from '#mcp-gateway/agent-catalog-views/models/catalog-types';
import type {
	ListRequest,
	PortalToolResult,
	SearchRequest,
	DescribeRequest,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';
import { itemError, itemOutput } from '#mcp-gateway/portal-tools/portal-batch-results';
import {
	findTool,
	applyExactFilters,
	paginate,
	selectorsFromInput,
	missingSelectorError,
} from '#mcp-gateway/portal-tools/portal-tool-selection';
import { generateTypescriptCatalogArtifact } from '#mcp-gateway/portal-tools/typescript-catalog-artifact';
import type { ToolSearchResult } from '#mcp-gateway/tool-search/models/search-index';
import type { ToolSchemaHint, ToolSummary } from '#mcp-gateway/tool-search/models/tool-summary';
import { createToolSummary } from '#mcp-gateway/tool-search/tool-summary';

const describeBeforeCallSchemaHint = {
	message: 'Use mcp_portal_describe for exact input schema before calling.',
	next: 'describe_before_call',
} as const satisfies ToolSchemaHint;

const callReadySchemaHint = {
	message: 'Full input schema included.',
	next: 'call_ready',
} as const satisfies ToolSchemaHint;

function describeToolOutput(props: {
	readonly includeJsonSchema: boolean;
	readonly includeRelated: boolean;
	readonly typescriptHelper: string | undefined;
	readonly includeZod: boolean;
	readonly session: AgentCatalogView;
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
	session: AgentCatalogView,
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

export function listRequestResult(
	session: AgentCatalogView,
	request: ListRequest,
): PortalToolResult {
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

export function searchRequestResult(
	session: AgentCatalogView,
	request: SearchRequest,
): PortalToolResult {
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

export async function describeRequestResult(
	session: AgentCatalogView,
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
