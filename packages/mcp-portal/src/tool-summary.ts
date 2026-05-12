import { portalToolRecordSchema, type PortalToolRecord } from './catalog-types.js';
import type { JsonObject } from './json-schema.js';
import { encodeToolRef } from './tool-ref.js';

export interface ToolSchemaSummary {
	readonly optional: readonly string[];
	readonly propertyCount: number;
	readonly required: readonly string[];
	readonly type: string;
}

export interface ToolSafetySummary {
	readonly destructiveHint?: boolean;
	readonly readOnlyHint?: boolean;
}

export interface ToolSummary {
	readonly description?: string;
	readonly input: ToolSchemaSummary;
	readonly namespace: string;
	readonly output?: ToolSchemaSummary;
	readonly safety: ToolSafetySummary;
	readonly title?: string;
	readonly toolName: string;
	readonly toolRef: string;
}

function stringArrayFromValue(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === 'string').toSorted();
}

function objectPropertiesFromSchema(schema: JsonObject): readonly string[] {
	const properties = schema.properties;
	if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
		return [];
	}

	return Object.keys(properties).toSorted();
}

export function summarizeJsonSchema(schema: JsonObject): ToolSchemaSummary {
	const properties = objectPropertiesFromSchema(schema);
	const required = stringArrayFromValue(schema.required);
	const requiredSet = new Set(required);
	const optional = properties.filter((propertyName) => !requiredSet.has(propertyName));

	return {
		optional,
		propertyCount: properties.length,
		required,
		type: typeof schema.type === 'string' ? schema.type : 'unknown',
	};
}

export function createToolSummary(tool: PortalToolRecord): ToolSummary {
	const parsed = portalToolRecordSchema.parse(tool);
	const safety = {
		...(parsed.annotations?.destructiveHint !== undefined
			? { destructiveHint: parsed.annotations.destructiveHint }
			: {}),
		...(parsed.annotations?.readOnlyHint !== undefined
			? { readOnlyHint: parsed.annotations.readOnlyHint }
			: {}),
	};

	return {
		...(parsed.description !== undefined ? { description: parsed.description } : {}),
		input: summarizeJsonSchema(parsed.inputSchema),
		namespace: parsed.namespace,
		...(parsed.outputSchema ? { output: summarizeJsonSchema(parsed.outputSchema) } : {}),
		safety,
		...(parsed.title !== undefined ? { title: parsed.title } : {}),
		toolName: parsed.toolName,
		toolRef: encodeToolRef({ namespace: parsed.namespace, toolName: parsed.toolName }),
	};
}
