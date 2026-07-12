import { z } from 'zod';

import { ArtifactReferenceSchema } from '../../artifact-surface/models/artifact-reference-schema.js';
import {
	CapabilityDescriptorSchema,
	CapabilitySearchMatchSchema,
	CapabilitySummarySchema,
} from '../../capability-description-surface/models/capability-descriptor-schema.js';
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

// oxlint-disable-next-line explicit-function-return-type -- Preserve the exact Zod discriminated-union inference for each operation-specific result schema.
function createPortalItemResultSchema<TValueSchema extends z.ZodType>(valueSchema: TValueSchema) {
	return z.discriminatedUnion('status', [
		z
			.object({
				artifacts: z.array(ArtifactReferenceSchema).optional(),
				diagnostics: z.array(SafeDiagnosticSchema).optional(),
				id: ItemIdSchema,
				status: z.literal('ok'),
				truncation: TruncationMetadataSchema.optional(),
				value: valueSchema,
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
}

// oxlint-disable-next-line explicit-function-return-type -- Preserve the exact Zod object inference derived from the item schema.
function createPortalResultSchema<TItemSchema extends z.ZodType<{ readonly status: string }>>(
	itemSchema: TItemSchema,
) {
	return z
		.object({
			auditCorrelationId: z.string().min(1).optional(),
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			items: z.array(itemSchema),
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
}

export const PortalCallItemResultSchema = createPortalItemResultSchema(JsonValueSchema);

export const PortalListItemValueSchema = z
	.object({
		namespaces: z.array(z.string().min(1)),
		nextCursor: z.string().regex(/^\d+$/u).optional(),
		tools: z.array(CapabilitySummarySchema),
	})
	.strict();

export const PortalSearchItemValueSchema = z
	.object({
		tools: z.array(CapabilitySearchMatchSchema),
	})
	.strict();

export const PortalDescribeItemValueSchema = z
	.object({
		tools: z.array(CapabilityDescriptorSchema),
	})
	.strict();

export const PortalListItemResultSchema = createPortalItemResultSchema(PortalListItemValueSchema);
export const PortalSearchItemResultSchema = createPortalItemResultSchema(
	PortalSearchItemValueSchema,
);
export const PortalDescribeItemResultSchema = createPortalItemResultSchema(
	PortalDescribeItemValueSchema,
);

export const PortalCallResultSchema = createPortalResultSchema(PortalCallItemResultSchema);

export type PortalCallResult = z.infer<typeof PortalCallResultSchema>;

export const PortalListResultSchema = createPortalResultSchema(PortalListItemResultSchema);
export type PortalListResult = z.infer<typeof PortalListResultSchema>;

export const PortalSearchResultSchema = createPortalResultSchema(PortalSearchItemResultSchema);
export type PortalSearchResult = z.infer<typeof PortalSearchResultSchema>;

export const PortalDescribeResultSchema = createPortalResultSchema(PortalDescribeItemResultSchema);
export type PortalDescribeResult = z.infer<typeof PortalDescribeResultSchema>;

export const PortalGenericItemResultSchema = z.discriminatedUnion('status', [
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
