import { z } from 'zod';

import { ArtifactReferenceSchema } from '../../artifact-surface/models/artifact-reference-schema.js';
import {
	CapabilityDescriptorSchema,
	CapabilitySearchMatchSchema,
	CapabilitySummarySchema,
} from '../../capability-description-surface/models/capability-descriptor-schema.js';
import { JsonValueSchema } from '../../contract-primitives/models/json-value-schema.js';
import { EffectiveNamespaceDiscoverySchema } from '../../contract-primitives/models/namespace-discovery-schema.js';
import { ItemIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { withPortableSuperRefinement } from '../../portable-contracts/portable-refinement-authoring.js';
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

const CompletedSucceededOutcomeSchema = z
	.object({
		certainty: z.literal('proven'),
		completion: z.literal('succeeded'),
		kind: z.literal('completed'),
		retryClass: z.literal('forbidden'),
	})
	.strict();

const CompletedFailedOutcomeSchema = z
	.object({
		certainty: z.literal('proven'),
		completion: z.literal('failed'),
		kind: z.literal('completed'),
		retryClass: z.enum(['forbidden', 'policy-gated']),
	})
	.strict();

const NotDispatchedOutcomeSchema = z
	.object({
		certainty: z.literal('proven'),
		kind: z.literal('not-dispatched'),
		retryClass: z.literal('safe-before-dispatch'),
	})
	.strict();

const ProvenTerminatedOutcomeSchema = z.union([
	z
		.object({
			certainty: z.literal('proven-terminated'),
			kind: z.literal('cancelled-proven'),
			retryClass: z.literal('manual-only'),
		})
		.strict(),
	z
		.object({
			certainty: z.literal('proven-terminated'),
			kind: z.literal('timed-out-proven'),
			retryClass: z.literal('manual-only'),
		})
		.strict(),
	z
		.object({
			certainty: z.literal('proven-terminated'),
			kind: z.literal('replaced-proven'),
			priorSideEffects: z.literal('possible'),
			retryClass: z.literal('manual-only'),
		})
		.strict(),
]);

const AmbiguousOutcomeSchema = z
	.object({
		certainty: z.literal('side-effects-and-termination-unknown'),
		kind: z.literal('ambiguous'),
		retryClass: z.literal('forbidden'),
	})
	.strict();

const TerminalErrorOutcomeSchema = z.union([
	NotDispatchedOutcomeSchema,
	CompletedFailedOutcomeSchema,
	ProvenTerminatedOutcomeSchema,
	AmbiguousOutcomeSchema,
]);

export const PortalApprovalChallengeSchema = z
	.object({
		challengeId: z.string().uuid(),
		expiresAt: z.string().datetime(),
	})
	.strict();

export const PortalApprovalRequiredCallItemResultSchema = z
	.object({
		approvalChallenge: PortalApprovalChallengeSchema,
		error: PortalErrorSchema.extend({ code: z.literal('approval_required') }).strict(),
		id: ItemIdSchema,
		operationId: z.string().min(1),
		outcome: NotDispatchedOutcomeSchema,
		owningGeneration: z.string().min(1),
		status: z.literal('approval_required'),
	})
	.strict();

export const PortalCallItemResultSchema = z.discriminatedUnion('status', [
	z
		.object({
			artifacts: z.array(ArtifactReferenceSchema).optional(),
			diagnostics: z.array(SafeDiagnosticSchema).optional(),
			id: ItemIdSchema,
			operationId: z.string().min(1),
			outcome: CompletedSucceededOutcomeSchema,
			owningGeneration: z.string().min(1),
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
			operationId: z.string().min(1),
			outcome: TerminalErrorOutcomeSchema,
			owningGeneration: z.string().min(1),
			status: z.literal('error'),
		})
		.strict(),
	PortalApprovalRequiredCallItemResultSchema,
]);

// oxlint-disable-next-line explicit-function-return-type -- Preserve the exact Zod object inference derived from the item schema.
function createPortalResultSchema<TItemSchema extends z.ZodType<{ readonly status: string }>>(
	itemSchema: TItemSchema,
) {
	return withPortableSuperRefinement({
		refinement: (result, context) => {
			const allItemsSucceeded = result.items.every((item) => item.status === 'ok');
			if (result.ok !== allItemsSucceeded) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Portal result ok must match item statuses.',
					path: ['ok'],
				});
			}
		},
		refinementIdentity: 'portal.result.aggregate-status',
		schema: z
			.object({
				auditCorrelationId: z.string().min(1).optional(),
				diagnostics: z.array(SafeDiagnosticSchema).optional(),
				items: z.array(itemSchema),
				ok: z.boolean(),
			})
			.strict(),
	});
}

export const PortalBackendListItemValueSchema = z
	.object({
		namespaces: z.array(z.string().min(1)),
		nextCursor: z.string().regex(/^\d+$/u).optional(),
		tools: z.array(CapabilitySummarySchema),
	})
	.strict();

export const PortalBackendSearchItemValueSchema = z
	.object({
		tools: z.array(CapabilitySearchMatchSchema),
	})
	.strict();

export const PortalBackendDescribeItemValueSchema = z
	.object({
		tools: z.array(CapabilityDescriptorSchema),
	})
	.strict();

export const PortalListItemValueSchema = PortalBackendListItemValueSchema.extend({
	namespaceDiscovery: z.array(EffectiveNamespaceDiscoverySchema),
}).strict();

export const PortalSearchItemValueSchema = PortalBackendSearchItemValueSchema.extend({
	namespaceDiscovery: z.array(EffectiveNamespaceDiscoverySchema),
}).strict();

export const PortalDescribeItemValueSchema = PortalBackendDescribeItemValueSchema.extend({
	namespaceDiscovery: z.array(EffectiveNamespaceDiscoverySchema),
}).strict();

export const PortalBackendListItemResultSchema = createPortalItemResultSchema(
	PortalBackendListItemValueSchema,
);
export const PortalBackendSearchItemResultSchema = createPortalItemResultSchema(
	PortalBackendSearchItemValueSchema,
);
export const PortalBackendDescribeItemResultSchema = createPortalItemResultSchema(
	PortalBackendDescribeItemValueSchema,
);

export const PortalBackendListResultSchema = createPortalResultSchema(
	PortalBackendListItemResultSchema,
);
export type PortalBackendListResult = z.infer<typeof PortalBackendListResultSchema>;

export const PortalBackendSearchResultSchema = createPortalResultSchema(
	PortalBackendSearchItemResultSchema,
);
export type PortalBackendSearchResult = z.infer<typeof PortalBackendSearchResultSchema>;

export const PortalBackendDescribeResultSchema = createPortalResultSchema(
	PortalBackendDescribeItemResultSchema,
);
export type PortalBackendDescribeResult = z.infer<typeof PortalBackendDescribeResultSchema>;

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
