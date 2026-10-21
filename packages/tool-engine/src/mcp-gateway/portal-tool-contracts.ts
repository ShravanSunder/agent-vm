import {
	type PortalAgentIdentity,
	type PortalToolSelector,
} from '@agent-collaboration/tool-access/authorization';
import { jsonObjectSchema, type JsonObject } from '@agent-collaboration/tool-access/contracts';
import type { ResourceResult } from '@agent-collaboration/tool-engine/dispatch';
import { ToolSchema } from '@modelcontextprotocol/core';
import type { Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { PortalToolRecord } from '#mcp-gateway/catalog-types';
import type { PortalCallAuthorization, VerifiedCallApproval } from '#mcp-gateway/gateway-approval';
import type { PortalSession } from '#mcp-gateway/portal-session';

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

export interface PortalSafeTransportDiagnostic {
	readonly kind: string;
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

export type SelectorInputResult =
	| { readonly error: PortalBatchError; readonly ok: false }
	| { readonly ok: true; readonly selectors: readonly PortalToolSelector[] };
export type ExactFilterResult =
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
export const listInputSchema = z.object({ requests: z.array(listRequestSchema).min(1) }).strict();
export const searchInputSchema = z
	.object({ requests: z.array(searchRequestSchema).min(1) })
	.strict();
export const describeInputSchema = z
	.object({ requests: z.array(describeRequestSchema).min(1) })
	.strict();
const callInputSchema = z.object({ calls: z.array(callRequestSchema).min(1) }).strict();
export const callExecutionInputSchema = callInputSchema.extend({
	portalApprovalToken: z.string().min(1).optional(),
});

export type ListRequest = z.infer<typeof listRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type DescribeRequest = z.infer<typeof describeRequestSchema>;
export type CallRequest = z.infer<typeof callRequestSchema>;

export interface PreparedPortalCall {
	readonly input: CallRequest;
	readonly validatedArguments: JsonObject;
	readonly tool: PortalToolRecord;
}

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

export interface PortalToolHandlerCall {
	readonly identity: PortalAgentIdentity;
	readonly input: unknown;
}

export interface PortalToolRuntime {
	readonly dispatchCall: (call: {
		readonly approval?: VerifiedCallApproval;
		readonly arguments: JsonObject;
		readonly identity: PortalAgentIdentity;
		readonly namespace: string;
		readonly requestId: string;
		readonly toolName: string;
	}) => Promise<ResourceResult>;
	readonly getSession: (identity: PortalAgentIdentity) => Promise<PortalSession>;
	readonly authorizeCalls?: (
		calls: readonly PreparedPortalCall[],
		token: string | undefined,
	) => Promise<ReadonlyMap<string, PortalCallAuthorization>>;
}

export interface PortalToolHandlers {
	readonly call: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
	readonly describe: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
	readonly list: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
	readonly search: (call: PortalToolHandlerCall) => Promise<PortalBatchResult>;
}
