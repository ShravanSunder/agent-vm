import {
	JsonValueSchema,
	PortalErrorSchema,
	SafeDiagnosticSchema,
} from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

export const ControllerExecutionResultSchema = z.discriminatedUnion('status', [
	z
		.object({
			auditCorrelationId: z.string().min(1),
			diagnostics: z.array(SafeDiagnosticSchema).default([]),
			status: z.literal('ok'),
			value: JsonValueSchema,
		})
		.strict(),
	z
		.object({
			auditCorrelationId: z.string().min(1).optional(),
			diagnostics: z.array(SafeDiagnosticSchema).default([]),
			error: PortalErrorSchema,
			status: z.literal('error'),
		})
		.strict(),
]);

export type ControllerExecutionResult = z.infer<typeof ControllerExecutionResultSchema>;
