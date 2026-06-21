import { z } from 'zod';

import { ArtifactReferenceSchema } from '../../artifact-surface/models/artifact-reference-schema.js';
import { JsonValueSchema } from '../../contract-primitives/models/json-value-schema.js';
import { ItemIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { SafeDiagnosticSchema } from '../../portal-event-surface/models/safe-diagnostic-schema.js';
import { PortalErrorSchema } from './portal-error-schema.js';

export const TruncationMetadataSchema = z
	.object({
		omittedBytes: z.number().int().nonnegative().optional(),
		truncated: z.boolean(),
	})
	.strict();

export const PortalCallItemResultSchema = z.discriminatedUnion('status', [
	z
		.object({
			artifacts: z.array(ArtifactReferenceSchema).optional(),
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			id: ItemIdSchema,
			status: z.literal('ok'),
			truncation: TruncationMetadataSchema.optional(),
			value: JsonValueSchema,
		})
		.strict(),
	z
		.object({
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			error: PortalErrorSchema,
			id: ItemIdSchema,
			status: z.literal('error'),
		})
		.strict(),
]);

export const PortalCallResultSchema = z
	.object({
		auditCorrelationId: z.string().min(1).optional(),
		diagnostics: z.array(SafeDiagnosticSchema).optional(),
		items: z.array(PortalCallItemResultSchema),
		ok: z.boolean(),
	})
	.strict()
	.superRefine((result, context) => {
		const allItemsSucceeded = result.items.every((item) => item.status === 'ok');
		if (result.ok !== allItemsSucceeded) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Portal result ok must match item statuses.',
				path: ['ok'],
			});
		}
	});

export type PortalCallResult = z.infer<typeof PortalCallResultSchema>;

export const PortalListResultSchema = PortalCallResultSchema;
export const PortalSearchResultSchema = PortalCallResultSchema;
export const PortalDescribeResultSchema = PortalCallResultSchema;
