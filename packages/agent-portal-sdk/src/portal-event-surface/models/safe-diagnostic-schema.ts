import { z } from 'zod';

export const SafeDiagnosticCodeSchema = z.enum([
	'provider_unavailable',
	'capability_denied',
	'tool_vm_advisory_hint_denied',
	'approval_required',
	'validation_failed',
	'execution_failed',
	'output_truncated',
	'timeout',
	'cancelled',
	'artifact_unavailable',
]);

export const SafeDiagnosticSchema = z
	.object({
		code: SafeDiagnosticCodeSchema,
		level: z.enum(['debug', 'info', 'warn', 'error']),
		safeMessage: z.string().max(500),
		safeParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
	})
	.strict();

export type SafeDiagnostic = z.infer<typeof SafeDiagnosticSchema>;
