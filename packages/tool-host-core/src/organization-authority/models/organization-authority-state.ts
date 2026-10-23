import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { z } from 'zod';

export const agentAdmissionSchema = z.strictObject({ state: z.enum(['listed', 'removed']) });
export type AgentAdmission = z.infer<typeof agentAdmissionSchema>;
export const approvalUsesSchema = z.record(z.string(), z.number().finite());
export type ApprovalUses = z.infer<typeof approvalUsesSchema>;
export const approvalUsesKey = 'approval-uses-v1';

export type ApprovalTokenUseDecision =
	| { readonly result: { readonly ok: true }; readonly next: ApprovalUses }
	| { readonly result: Extract<ConsumeApprovalTokenResult, { readonly ok: false }> };
