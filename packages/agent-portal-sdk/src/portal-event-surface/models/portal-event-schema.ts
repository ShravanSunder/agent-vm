import { z } from 'zod';

import { ItemIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { PortalErrorSchema } from '../../portal-call-surface/models/portal-error-schema.js';
import { SafeDiagnosticSchema } from './safe-diagnostic-schema.js';

export const PortalProgressEventSchema = z
	.object({
		id: ItemIdSchema,
		kind: z.literal('progress'),
		message: z.string().max(500),
		percent: z.number().min(0).max(100).optional(),
	})
	.strict();

export type PortalProgressEvent = z.infer<typeof PortalProgressEventSchema>;

export const PortalPartialOutputEventSchema = z
	.object({
		id: ItemIdSchema,
		kind: z.literal('partial_output'),
		stream: z.enum(['stdout', 'stderr', 'result']),
		text: z.string().max(16_384),
		truncated: z.boolean().default(false),
	})
	.strict();

export type PortalPartialOutputEvent = z.infer<typeof PortalPartialOutputEventSchema>;

export const PortalDiagnosticEventSchema = z
	.object({
		diagnostic: SafeDiagnosticSchema,
		id: ItemIdSchema,
		kind: z.literal('diagnostic'),
	})
	.strict();

export type PortalDiagnosticEvent = z.infer<typeof PortalDiagnosticEventSchema>;

export const PortalCancellationRequestEventSchema = z
	.object({
		id: ItemIdSchema,
		kind: z.literal('cancellation_requested'),
		reason: z.string().max(500).optional(),
	})
	.strict();

export type PortalCancellationRequestEvent = z.infer<typeof PortalCancellationRequestEventSchema>;

export const PortalCancellationResultEventSchema = z
	.object({
		error: PortalErrorSchema.optional(),
		id: ItemIdSchema,
		kind: z.literal('cancellation_result'),
		status: z.enum(['cancelled', 'not_found', 'already_finished']),
	})
	.strict();

export type PortalCancellationResultEvent = z.infer<typeof PortalCancellationResultEventSchema>;

export const PortalEventSchema = z.discriminatedUnion('kind', [
	PortalProgressEventSchema,
	PortalPartialOutputEventSchema,
	PortalDiagnosticEventSchema,
	PortalCancellationRequestEventSchema,
	PortalCancellationResultEventSchema,
]);

export type PortalEvent = z.infer<typeof PortalEventSchema>;
