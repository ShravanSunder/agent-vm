// Copied from agent-vm at 7cb295d1; existing packages remain unchanged until S4.
import { z } from 'zod';
export const namespaceToolRefSchema = z
	.object({
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();

export type NamespaceToolRef = z.infer<typeof namespaceToolRefSchema>;

export const portalToolSelectorSchema = z
	.object({
		allow: z.union([z.literal('*'), z.array(z.string().min(1))]),
		deny: z.array(z.string().min(1)).default([]),
	})
	.strict();

export type PortalToolSelector = z.infer<typeof portalToolSelectorSchema>;

export const portalApprovalConfigSchema = z
	.object({
		allowWithoutApprovalTools: z.array(namespaceToolRefSchema).default([]),
		alwaysAskTools: z.array(namespaceToolRefSchema).default([]),
		annotationPolicy: z
			.enum(['destructive-requires-approval', 'always-require-approval'])
			.default('destructive-requires-approval'),
		callPoliciesByNamespace: z
			.record(
				z.string().min(1),
				z
					.object({
						requiresApproval: portalToolSelectorSchema,
						withoutApproval: portalToolSelectorSchema,
					})
					.strict(),
			)
			.default({}),
		trustedAnnotationNamespaces: z.array(z.string().min(1)).default([]),
		writeTools: z.array(namespaceToolRefSchema).default([]),
	})
	.strict();

export type PortalApprovalConfig = z.infer<typeof portalApprovalConfigSchema>;

const portalNamespaceCallPolicySchema = z
	.object({
		requiresApproval: portalToolSelectorSchema,
		withoutApproval: portalToolSelectorSchema,
	})
	.strict();

const portalNamespaceApprovalSchema = z
	.object({
		allowWithoutApproval: z.array(z.string().min(1)).default([]),
		alwaysAsk: z.array(z.string().min(1)).default([]),
		trustedAnnotations: z.boolean().default(false),
		write: z.array(z.string().min(1)).default([]),
	})
	.strict();

const defaultPortalNamespaceApproval = {
	allowWithoutApproval: [],
	alwaysAsk: [],
	trustedAnnotations: false,
	write: [],
} satisfies z.infer<typeof portalNamespaceApprovalSchema>;

const portalNamespacePolicySchema = z
	.object({
		approval: portalNamespaceApprovalSchema.default(defaultPortalNamespaceApproval).optional(),
		calls: portalNamespaceCallPolicySchema,
		tools: portalToolSelectorSchema,
	})
	.strict();

export const mcpPortalProfileDefinitionSchema = z
	.object({
		approval: z
			.object({
				annotationPolicy: portalApprovalConfigSchema.shape.annotationPolicy.optional(),
			})
			.strict()
			.optional(),
		namespaces: z.record(z.string().min(1), portalNamespacePolicySchema).default({}),
		logging: z
			.object({ enabled: z.boolean().default(false) })
			.strict()
			.optional(),
		promptContext: z
			.object({
				enabled: z.boolean().default(true),
				maxNamespaces: z.number().int().positive().default(12),
			})
			.strict()
			.optional(),
		cache: z
			.object({
				catalogTtlMs: z.number().int().positive().default(60_000),
			})
			.strict()
			.optional(),
	})
	.strict();

export type McpPortalProfileDefinition = z.infer<typeof mcpPortalProfileDefinitionSchema>;

export const resolvedMcpPortalProfileSchema = z
	.object({
		enabledNamespaces: z.array(z.string().min(1)),
		enabledToolsByNamespace: z.record(z.string().min(1), z.array(z.string().min(1))),
		hiddenToolsByNamespace: z.record(z.string().min(1), z.array(z.string().min(1))),
		logging: z.object({ enabled: z.boolean() }).strict(),
		promptContext: z
			.object({
				enabled: z.boolean(),
				maxNamespaces: z.number().int().positive(),
			})
			.strict(),
		cache: z.object({ catalogTtlMs: z.number().int().positive() }).strict(),
		approval: portalApprovalConfigSchema,
	})
	.strict();

export type ResolvedMcpPortalProfile = z.infer<typeof resolvedMcpPortalProfileSchema>;
