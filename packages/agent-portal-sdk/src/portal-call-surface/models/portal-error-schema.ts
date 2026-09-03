import { z } from 'zod';

import { SafeDiagnosticSchema } from '../../portal-event-surface/models/safe-diagnostic-schema.js';

export const PortalErrorCodeSchema = z.enum([
	'invalid_request',
	'not_found',
	'not_authorized',
	'approval_required',
	'capability_denied',
	'tool_vm_advisory_hint_denied',
	'validation_failed',
	'provider_unavailable',
	'execution_failed',
	'cancelled',
	'timeout',
]);

export type PortalErrorCode = z.infer<typeof PortalErrorCodeSchema>;

export const PortalErrorSchema = z
	.object({
		code: PortalErrorCodeSchema,
		message: z.string().min(1).max(500),
		retryable: z.boolean().optional(),
		safeDiagnostic: SafeDiagnosticSchema.optional(),
	})
	.strict();

export type PortalError = z.infer<typeof PortalErrorSchema>;
