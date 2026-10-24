import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
	callInputSchema,
	describeInputSchema,
	listInputSchema,
	searchInputSchema,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';

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
