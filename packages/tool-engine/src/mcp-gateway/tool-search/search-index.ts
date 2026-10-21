import type { JsonValue, JsonObject } from '@agent-collaboration/tool-access/contracts';

import {
	type PortalToolRecord,
	portalToolRecordSchema,
} from '#mcp-gateway/agent-catalog-views/models/catalog-types';
import type {
	ToolRelationshipHint,
	SearchEntry,
	ToolSearchResult,
	SearchIndex,
	SearchQuery,
	SearchResultSet,
} from '#mcp-gateway/tool-search/models/search-index';
import type { ToolRelationship, ToolGraph } from '#mcp-gateway/tool-search/models/tool-graph';
import type { ToolSummary } from '#mcp-gateway/tool-search/models/tool-summary';
import { createToolSummary } from '#mcp-gateway/tool-search/tool-summary';

function collectSchemaText(value: JsonValue, parts: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectSchemaText(item, parts);
		}
		return;
	}

	if (typeof value !== 'object' || value === null) {
		if (typeof value === 'string') {
			parts.push(value);
		}
		return;
	}

	for (const [key, childValue] of Object.entries(value)) {
		parts.push(key);
		collectSchemaText(childValue, parts);
	}
}

function normalizeSearchText(text: string): string {
	return text.toLowerCase().replace(/[_-]/g, ' ');
}

function buildSearchText(tool: PortalToolRecord): string {
	const parts = [tool.namespace, tool.toolName, tool.title ?? '', tool.description ?? ''];
	collectSchemaText(tool.inputSchema, parts);
	if (tool.outputSchema) {
		collectSchemaText(tool.outputSchema, parts);
	}

	return normalizeSearchText(parts.join(' '));
}

function propertiesFromSchema(schema: JsonObject): readonly string[] {
	const properties = schema.properties;
	if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
		return [];
	}

	return Object.keys(properties).toSorted();
}

function createRelationshipHints(
	tool: PortalToolRecord,
	relationships: readonly ToolRelationship[],
): readonly ToolRelationshipHint[] {
	const targetToolRef = createToolSummary(tool).toolRef;

	return relationships
		.filter((relationship) => relationship.to.toolRef === targetToolRef)
		.map((relationship) =>
			relationship.field === undefined
				? {
						reason: relationship.reason,
						sourceToolRef: relationship.from.toolRef,
						type: relationship.type,
					}
				: {
						field: relationship.field,
						reason: relationship.reason,
						sourceToolRef: relationship.from.toolRef,
						type: relationship.type,
					},
		)
		.toSorted((left, right) => {
			const typeOrder = left.type.localeCompare(right.type);
			if (typeOrder !== 0) {
				return typeOrder;
			}
			return left.sourceToolRef.localeCompare(right.sourceToolRef);
		});
}

function scopedSkillText(toolRef: string, graph?: ToolGraph): string {
	if (!graph) {
		return '';
	}

	return graph.skills
		.filter((skill) => skill.toolRefs.includes(toolRef))
		.map((skill) => [skill.title, skill.description ?? '', ...skill.tags].join(' '))
		.join(' ');
}

function scoreEntry(entry: SearchEntry, terms: readonly string[]): number {
	let score = 0;
	for (const term of terms) {
		if (entry.searchText.includes(term)) {
			score += 1;
		}
	}

	return score;
}

function compareSummaries(left: ToolSummary, right: ToolSummary): number {
	const namespaceOrder = left.namespace.localeCompare(right.namespace);
	if (namespaceOrder !== 0) {
		return namespaceOrder;
	}

	return left.toolName.localeCompare(right.toolName);
}

function withRelationshipHints(
	summary: ToolSummary,
	relationshipHints: readonly ToolRelationshipHint[],
): ToolSearchResult {
	if (relationshipHints.length === 0) {
		return summary;
	}

	return {
		...(summary.description !== undefined ? { description: summary.description } : {}),
		input: summary.input,
		namespace: summary.namespace,
		...(summary.output !== undefined ? { output: summary.output } : {}),
		relationshipHints,
		safety: summary.safety,
		...(summary.title !== undefined ? { title: summary.title } : {}),
		toolName: summary.toolName,
		toolRef: summary.toolRef,
	};
}

function withSchemaFieldMatches(
	summary: ToolSearchResult,
	schemaFieldMatches: readonly string[],
): ToolSearchResult {
	if (schemaFieldMatches.length === 0) {
		return summary;
	}

	return {
		...(summary.description !== undefined ? { description: summary.description } : {}),
		input: summary.input,
		namespace: summary.namespace,
		...(summary.output !== undefined ? { output: summary.output } : {}),
		...(summary.relationshipHints !== undefined
			? { relationshipHints: summary.relationshipHints }
			: {}),
		safety: summary.safety,
		schemaFieldMatches,
		...(summary.title !== undefined ? { title: summary.title } : {}),
		toolName: summary.toolName,
		toolRef: summary.toolRef,
	};
}

export function createSearchIndex(
	tools: readonly PortalToolRecord[],
	graph?: ToolGraph,
): SearchIndex {
	const entries = tools
		.map((tool) => portalToolRecordSchema.parse(tool))
		.map((tool) => {
			const summary = createToolSummary(tool);
			const relationshipHints = createRelationshipHints(tool, graph?.relationships ?? []);
			const inputFields = propertiesFromSchema(tool.inputSchema);
			const relationText = relationshipHints
				.map((hint) => [hint.field ?? '', hint.reason, hint.sourceToolRef, hint.type].join(' '))
				.join(' ');
			const skillText = scopedSkillText(summary.toolRef, graph);

			return {
				inputFields,
				relationshipHints,
				searchText: normalizeSearchText([buildSearchText(tool), relationText, skillText].join(' ')),
				summary: withRelationshipHints(summary, relationshipHints),
			};
		})
		.toSorted((left, right) => compareSummaries(left.summary, right.summary));

	return {
		search(query: SearchQuery): SearchResultSet {
			const limit = Math.max(0, Math.floor(query.limit));
			const namespaceFilter = new Set(query.namespaces ?? []);
			const terms = normalizeSearchText(query.query ?? '')
				.split(/\s+/)
				.map((term) => term.trim())
				.filter(Boolean);
			const scoredEntries = entries
				.filter(
					(entry) => namespaceFilter.size === 0 || namespaceFilter.has(entry.summary.namespace),
				)
				.map((entry) => ({ entry, score: terms.length === 0 ? 1 : scoreEntry(entry, terms) }))
				.filter(({ score }) => score > 0)
				.toSorted((left, right) => {
					if (right.score !== left.score) {
						return right.score - left.score;
					}
					return compareSummaries(left.entry.summary, right.entry.summary);
				});

			const results = scoredEntries.slice(0, limit).map(({ entry }) => {
				const schemaFieldMatches = entry.inputFields
					.filter((fieldName) =>
						terms.some((term) => normalizeSearchText(fieldName).includes(term)),
					)
					.toSorted();

				return withSchemaFieldMatches(entry.summary, schemaFieldMatches);
			});

			return { results };
		},
	};
}
