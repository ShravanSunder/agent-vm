import { z } from 'zod';

export const ToolVmAdvisoryHintContextSchema = z
	.object({
		bypassableWithinToolVm: z.literal(true),
		kind: z.literal('tool_vm_advisory_hint'),
		scope: z.literal('tool_portal_call_only'),
	})
	.strict();

export type ToolVmAdvisoryHintContext = z.infer<typeof ToolVmAdvisoryHintContextSchema>;
