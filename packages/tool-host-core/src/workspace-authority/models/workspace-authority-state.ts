import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { z } from 'zod';

export const approvalUsesSchema = z.record(z.string(), z.number().finite());
export type ApprovalUses = z.infer<typeof approvalUsesSchema>;
export const approvalUsesKey = 'approval-uses-v1';

export type ApprovalTokenUseDecision =
	| { readonly result: { readonly ok: true }; readonly next: ApprovalUses }
	| { readonly result: Extract<ConsumeApprovalTokenResult, { readonly ok: false }> };
