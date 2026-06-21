import { z } from 'zod';

import { JsonObjectSchema } from '../../contract-primitives/models/json-value-schema.js';
import { RequestIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { addDuplicateItemIdIssues } from './portal-batch-id-refinement.js';

export const PortalBatchMaxItems = 50;

export const PortalCallItemRequestSchema = z
	.object({
		arguments: JsonObjectSchema,
		id: RequestIdSchema,
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();

export const PortalCallRequestSchema = z
	.object({
		calls: z.array(PortalCallItemRequestSchema).min(1).max(PortalBatchMaxItems),
		requestId: RequestIdSchema.optional(),
	})
	.strict()
	.superRefine((request, context) => {
		addDuplicateItemIdIssues(request.calls, context);
	});

export type PortalCallRequest = z.infer<typeof PortalCallRequestSchema>;
