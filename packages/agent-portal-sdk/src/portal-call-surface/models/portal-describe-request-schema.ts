import { z } from 'zod';

import { CapabilityReferenceSchema } from '../../contract-primitives/models/capability-reference-schema.js';
import { RequestIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { addDuplicateItemIdIssues } from './portal-batch-id-refinement.js';
import { PortalBatchMaxItems } from './portal-call-request-schema.js';

export const PortalDescribeItemRequestSchema = z
	.object({
		id: RequestIdSchema,
		includeJsonSchema: z.boolean().default(true),
		includeRelated: z.boolean().default(true),
		includeTypescriptHelper: z.boolean().default(false),
		includeZod: z.boolean().default(false),
		refs: z.array(z.string().min(1)).optional(),
		tools: z.array(CapabilityReferenceSchema).optional(),
	})
	.strict();

export const PortalDescribeRequestSchema = z
	.object({
		requestId: RequestIdSchema.optional(),
		requests: z.array(PortalDescribeItemRequestSchema).min(1).max(PortalBatchMaxItems),
	})
	.strict()
	.superRefine((request, context) => {
		addDuplicateItemIdIssues(request.requests, context);
	});

export type PortalDescribeRequest = z.infer<typeof PortalDescribeRequestSchema>;
