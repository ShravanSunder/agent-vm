import { z } from 'zod';

const namespaceToolSchema = z
	.object({
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();

export type NamespaceToolSelector = z.infer<typeof namespaceToolSchema>;

export const portalApprovalConfigSchema = z.object({
	allowWithoutApprovalTools: z.array(namespaceToolSchema).default([]),
	alwaysAskTools: z.array(namespaceToolSchema).default([]),
	annotationPolicy: z
		.enum(['destructive-requires-approval', 'off'])
		.default('destructive-requires-approval'),
	trustedAnnotationNamespaces: z.array(z.string()).default([]),
	writeTools: z.array(namespaceToolSchema).default([]),
});

export type PortalApprovalConfig = z.infer<typeof portalApprovalConfigSchema>;

export const portalConfigSchema = z
	.object({
		approval: portalApprovalConfigSchema.default({
			allowWithoutApprovalTools: [],
			alwaysAskTools: [],
			annotationPolicy: 'destructive-requires-approval',
			trustedAnnotationNamespaces: [],
			writeTools: [],
		}),
		cache: z
			.object({ catalogTtlMs: z.number().positive().default(60_000) })
			.default({ catalogTtlMs: 60_000 }),
		enabledNamespaces: z.array(z.string()).default([]),
		enabledNamespacesByAgent: z.record(z.string(), z.array(z.string())).default({}),
		hiddenToolsByAgent: z.record(z.string(), z.array(namespaceToolSchema)).default({}),
		promptContext: z
			.object({
				enabled: z.boolean().default(true),
				maxNamespaces: z.number().positive().default(12),
			})
			.default({ enabled: true, maxNamespaces: 12 }),
		skillsDirs: z.array(z.string()).default([]),
	})
	.strict();

export type PortalConfig = z.infer<typeof portalConfigSchema>;

export function parsePortalConfig(value: unknown): PortalConfig {
	const parsed = portalConfigSchema.parse(value);
	return {
		...parsed,
		approval: portalApprovalConfigSchema.parse(parsed.approval),
		cache: { catalogTtlMs: parsed.cache.catalogTtlMs ?? 60_000 },
		promptContext: {
			enabled: parsed.promptContext.enabled ?? true,
			maxNamespaces: parsed.promptContext.maxNamespaces ?? 12,
		},
	};
}
