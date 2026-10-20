// Copied from agent-vm at 7cb295d1; existing packages remain unchanged until S4.
import { z } from 'zod';
export const toolPortalToolSelectorSchema = z
	.object({
		allow: z.union([z.literal('*'), z.array(z.string().min(1))]),
		deny: z.array(z.string().min(1)).default([]),
	})
	.strict();

export type ToolPortalToolSelector = z.infer<typeof toolPortalToolSelectorSchema>;

export const toolPortalCallPolicySchema = z
	.object({
		requiresApproval: toolPortalToolSelectorSchema,
		withoutApproval: toolPortalToolSelectorSchema,
	})
	.strict()
	.superRefine((policy, context) => {
		if (toolSelectorsOverlap(policy.requiresApproval, policy.withoutApproval)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Tool Portal call policy cannot list one tool in both approval selectors.',
				path: ['withoutApproval'],
			});
		}
	});

export type ToolPortalCallPolicy = z.infer<typeof toolPortalCallPolicySchema>;

export const toolPortalNamespaceCallPolicySchema = z.union([
	toolPortalCallPolicySchema,
	z.object({ source: z.literal('managed_google_policy') }).strict(),
]);
export type ToolPortalNamespaceCallPolicy = z.infer<typeof toolPortalNamespaceCallPolicySchema>;
export const toolPortalBackendKindSchema = z.enum([
	'mcp_provider',
	'controller_execution',
	'tool_vm_runner',
]);
function toolSelectorsOverlap(
	left: ToolPortalToolSelector,
	right: ToolPortalToolSelector,
): boolean {
	const leftAllow = left.allow;
	const rightAllow = right.allow;
	if (leftAllow === '*' && rightAllow === '*') {
		return true;
	}
	if (leftAllow === '*') {
		if (rightAllow === '*') {
			return true;
		}
		return rightAllow.some((toolName) => !left.deny.includes(toolName));
	}
	if (rightAllow === '*') {
		return leftAllow.some((toolName) => !right.deny.includes(toolName));
	}
	return leftAllow.some(
		(toolName) =>
			rightAllow.includes(toolName) &&
			!left.deny.includes(toolName) &&
			!right.deny.includes(toolName),
	);
}
