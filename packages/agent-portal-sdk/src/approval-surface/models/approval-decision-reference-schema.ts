import { z } from 'zod';

import { ItemIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { PortalErrorSchema } from '../../portal-call-surface/models/portal-error-schema.js';

export const ApprovalDecisionReferenceSchema = z
	.object({
		approvalId: z.string().min(1),
		callId: ItemIdSchema,
		expiresAt: z.string().datetime(),
		status: z.enum(['approved', 'denied', 'expired']),
	})
	.strict();

export type ApprovalDecisionReference = z.infer<typeof ApprovalDecisionReferenceSchema>;

export const ApprovalRequiredResultSchema = z
	.object({
		error: PortalErrorSchema.extend({
			code: z.literal('approval_required'),
		}),
		id: ItemIdSchema,
		status: z.literal('error'),
	})
	.strict();

export type ApprovalRequiredResult = z.infer<typeof ApprovalRequiredResultSchema>;
