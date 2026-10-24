import { z } from 'zod';

import { RequestIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { withPortableSuperRefinement } from '../../portable-contracts/portable-refinement-authoring.js';
import { addDuplicateItemIdIssues } from './portal-batch-id-refinement.js';
import { PortalBatchMaxItems } from './portal-call-request-schema.js';

export const PortalSearchItemRequestSchema = z
	.object({
		id: RequestIdSchema,
		limit: z.number().int().positive().max(50).default(10),
		namespaces: z.array(z.string().min(1)).optional(),
		query: z.string().optional(),
		schemaDetail: z.enum(['none', 'summary', 'full']).default('summary'),
	})
	.strict();

export const PortalSearchRequestSchema = withPortableSuperRefinement({
	refinement: (request, context) => {
		addDuplicateItemIdIssues(request.requests, context);
	},
	refinementIdentity: 'portal.batch.unique-item-ids',
	schema: z
		.object({
			requestId: RequestIdSchema.optional(),
			requests: z.array(PortalSearchItemRequestSchema).min(1).max(PortalBatchMaxItems),
		})
		.strict(),
});

export type PortalSearchRequest = z.infer<typeof PortalSearchRequestSchema>;
