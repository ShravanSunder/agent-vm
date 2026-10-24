import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import { ToolSchema } from '@modelcontextprotocol/core';
import type { Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
	callInputSchema,
	describeInputSchema,
	listInputSchema,
	searchInputSchema,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';

function toPortalInputJsonSchema(schema: z.ZodType): Tool['inputSchema'] {
	const jsonSchema = jsonObjectSchema.parse(z.toJSONSchema(schema, { io: 'input' }));
	if (jsonSchema.type !== 'object') {
		throw new Error('MCP Portal tool input schemas must be JSON Schema objects.');
	}
	return ToolSchema.shape.inputSchema.parse(jsonSchema);
}

export const portalToolInputSchemas = {
	mcp_portal_call: toPortalInputJsonSchema(callInputSchema),
	mcp_portal_describe: toPortalInputJsonSchema(describeInputSchema),
	mcp_portal_list: toPortalInputJsonSchema(listInputSchema),
	mcp_portal_search: toPortalInputJsonSchema(searchInputSchema),
} as const;
