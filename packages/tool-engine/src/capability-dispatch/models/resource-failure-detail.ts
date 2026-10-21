import {
	CapabilityNameSchema,
	NamespaceNameSchema,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

/** Redacted connector facts; transport addresses and raw causes never cross dispatch. */
export const resourceFailureDetailSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('mcp-upstream-failure'),
		code: z.literal('upstream_call_failed'),
		message: z.string(),
		namespace: NamespaceNameSchema,
		toolName: CapabilityNameSchema,
		upstream: z.strictObject({
			attemptTransport: z.enum(['sse', 'streamable-http', 'stdio']).optional(),
			causeMessage: z.literal('Upstream MCP provider failed.'),
			elapsedMs: z.number().nonnegative(),
			failureClass: z
				.enum([
					'authentication',
					'authorization',
					'invalid_request',
					'provider_error',
					'rate_limit',
					'tool_error',
				])
				.optional(),
			hint: z.string().optional(),
			httpStatusCode: z.number().int().optional(),
			kind: z.literal('upstream_mcp_failed'),
			namespace: NamespaceNameSchema,
			operation: z.string(),
			phase: z.enum(['call_tool', 'connect', 'list_tools']),
			providerErrorMessage: z.string().max(2001).optional(),
			timeoutMs: z.number().nonnegative().optional(),
			toolName: CapabilityNameSchema.optional(),
			transport: z.strictObject({ kind: z.enum(['sse', 'streamable-http', 'stdio']) }),
		}),
	}),
]);
export type ResourceFailureDetail = z.infer<typeof resourceFailureDetailSchema>;
