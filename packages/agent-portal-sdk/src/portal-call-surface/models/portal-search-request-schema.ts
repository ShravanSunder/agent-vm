import { z } from 'zod';

import { RequestIdSchema } from '../../contract-primitives/models/request-id-schema.js';
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

export const PortalSearchRequestSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		requests: z.array(PortalSearchItemRequestSchema).min(1).max(PortalBatchMaxItems),
	})
	.strict()
	.superRefine((request, context) => {
		addDuplicateItemIdIssues(request.requests, context);
	});

export type PortalSearchRequest = z.infer<typeof PortalSearchRequestSchema>;
