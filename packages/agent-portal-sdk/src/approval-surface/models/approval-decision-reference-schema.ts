import { z } from 'zod';

import { ItemIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import {
	PortalApprovalChallengeSchema,
	PortalApprovalRequiredCallItemResultSchema,
} from '../../portal-call-surface/models/portal-call-result-schema.js';

export const ApprovalDecisionReferenceSchema = z
	.object({
		approvalId: z.string().min(1),
		callId: ItemIdSchema,
		expiresAt: z.string().datetime(),
		status: z.enum(['approved', 'denied', 'expired']),
	})
	.strict();

export type ApprovalDecisionReference = z.infer<typeof ApprovalDecisionReferenceSchema>;

export const ApprovalRequiredResultSchema = PortalApprovalRequiredCallItemResultSchema;

export const ApprovalChallengeReferenceSchema = PortalApprovalChallengeSchema;

export type ApprovalRequiredResult = z.infer<typeof ApprovalRequiredResultSchema>;
export type ApprovalChallengeReference = z.infer<typeof ApprovalChallengeReferenceSchema>;
