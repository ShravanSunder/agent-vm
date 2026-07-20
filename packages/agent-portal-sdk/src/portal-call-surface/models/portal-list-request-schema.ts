import { z } from 'zod';

import { CapabilityReferenceSchema } from '../../contract-primitives/models/capability-reference-schema.js';
import { RequestIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { withPortableSuperRefinement } from '../../portable-contracts/portable-refinement-authoring.js';
import { addDuplicateItemIdIssues } from './portal-batch-id-refinement.js';
import { PortalBatchMaxItems } from './portal-call-request-schema.js';

export const PortalListItemRequestSchema = z
	.object({
		cursor: z.string().regex(/^\d+$/u).optional(),
		id: RequestIdSchema,
		limit: z.number().int().positive().max(100).default(20),
		namespaces: z.array(z.string().min(1)).optional(),
		refs: z.array(z.string().min(1)).optional(),
		tools: z.array(CapabilityReferenceSchema).optional(),
	})
	.strict();

export const PortalListRequestSchema = withPortableSuperRefinement({
	refinement: (request, context) => {
		addDuplicateItemIdIssues(request.requests, context);
	},
	refinementIdentity: 'portal.batch.unique-item-ids',
	schema: z
		.object({
			requestId: RequestIdSchema.optional(),
			requests: z.array(PortalListItemRequestSchema).min(1).max(PortalBatchMaxItems),
		})
		.strict(),
});

export type PortalListRequest = z.infer<typeof PortalListRequestSchema>;
