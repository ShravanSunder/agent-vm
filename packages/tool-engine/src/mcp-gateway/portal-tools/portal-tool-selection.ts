import type { PortalToolSelector } from '@agent-collaboration/tool-access/authorization';

import type {
	AgentCatalogView,
	PortalDiscoveryFailure,
} from '#mcp-gateway/agent-catalog-views/models/agent-catalog-view';
import type { PortalToolRecord } from '#mcp-gateway/agent-catalog-views/models/catalog-types';
import { decodeToolRef } from '#mcp-gateway/agent-catalog-views/tool-ref';
import type {
	SelectorInputResult,
	ExactFilterResult,
	PortalBatchError,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';
import { messageFromError } from '#mcp-gateway/portal-tools/portal-batch-results';

export function findTool(
	session: AgentCatalogView,
	selector: PortalToolSelector,
): PortalToolRecord | null {
	return (
		session.catalog.tools.find(
			(tool) => tool.namespace === selector.namespace && tool.toolName === selector.toolName,
		) ?? null
	);
}

export function discoveryFailureForNamespace(
	session: AgentCatalogView,
	namespace: string,
): PortalDiscoveryFailure | null {
	return (
		session.catalog.discoveryFailures.find((failure) => failure.namespace === namespace) ?? null
	);
}

export function selectorsFromInput(
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

export function applyExactFilters(
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

export function missingSelectorError(
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

export function paginate<TItem>(
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
