import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';
import { secretValueSchema, type SecretValue } from './secret-value.js';

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

type PortalNamespacePolicy = z.infer<typeof portalNamespacePolicySchema>;

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

export const mcpPortalExternalAuthSchema = z
	.object({
		masterKey: secretValueSchema,
	})
	.strict();

export type McpPortalExternalAuthConfig = z.infer<typeof mcpPortalExternalAuthSchema>;

function isLoopbackProxyHost(host: string): boolean {
	const normalizedHost = host.toLowerCase();
	return (
		normalizedHost === 'localhost' || normalizedHost === '127.0.0.1' || normalizedHost === '::1'
	);
}

export const mcpPortalProxySchema = z
	.object({
		server: z
			.object({
				host: z
					.string()
					.min(1)
					.refine(isLoopbackProxyHost, {
						message: 'mcpProxy.server.host must be loopback-only for HTTP bearer auth.',
					})
					.default('127.0.0.1'),
				port: z.number().int().min(1).max(65_535).default(18_791),
			})
			.strict()
			.default({ host: '127.0.0.1', port: 18_791 }),
		auth: z
			.object({
				headerName: z.string().min(1).default('authorization'),
			})
			.strict()
			.default({ headerName: 'authorization' }),
	})
	.strict();

export type McpPortalProxyConfig = z.infer<typeof mcpPortalProxySchema>;

export const mcpPortalAgentConfigSchema = z
	.object({
		credentialVersion: z.number().int().positive().default(1),
		profile: z.string().min(1),
		hmacKey: secretValueSchema.optional(),
	})
	.strict();

export type McpPortalAgentConfig = z.infer<typeof mcpPortalAgentConfigSchema>;

export const mcpPortalConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		schemaVersion: z.literal(1),
		externalAuth: mcpPortalExternalAuthSchema.optional(),
		mcpProxy: mcpPortalProxySchema.optional(),
		agents: z.record(z.string().min(1), mcpPortalAgentConfigSchema).default({}),
		profiles: z.record(z.string().min(1), mcpPortalProfileDefinitionSchema),
	})
	.strict()
	.superRefine((config, context) => {
		if (Object.keys(config.profiles).length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'mcp-portal.config.jsonc must define at least one profile.',
				path: ['profiles'],
			});
		}
	});

type ParsedMcpPortalConfig = z.infer<typeof mcpPortalConfigSchema>;
export type McpPortalConfig = Omit<ParsedMcpPortalConfig, 'agents'> & {
	readonly agents: Readonly<Record<string, McpPortalAgentConfig>>;
};

const defaultProfile: ResolvedMcpPortalProfile = {
	approval: portalApprovalConfigSchema.parse({}),
	cache: { catalogTtlMs: 60_000 },
	enabledNamespaces: [],
	enabledToolsByNamespace: {},
	hiddenToolsByNamespace: {},
	logging: { enabled: false },
	promptContext: { enabled: true, maxNamespaces: 12 },
};

type AuthoredPortalNamespaces = McpPortalProfileDefinition['namespaces'];

export async function loadMcpPortalConfig(configPath: string): Promise<McpPortalConfig> {
	return mcpPortalConfigSchema.parse(await loadJsonConfigFile(configPath));
}

function namespaceToolRefs(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
	selector: (policy: PortalNamespacePolicy) => readonly string[],
): readonly NamespaceToolRef[] {
	return Object.entries(namespaces).flatMap(([namespace, policy]) =>
		selector(policy).map((toolName) => ({ namespace, toolName })),
	);
}

function selectorAllowList(selector: PortalToolSelector): readonly string[] {
	return selector.allow === '*' ? [] : selector.allow;
}

function selectorHasVisibleTools(selector: PortalToolSelector): boolean {
	return selector.allow === '*' || selector.allow.length > 0;
}

function activeNamespaces(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
): Readonly<Record<string, PortalNamespacePolicy>> {
	return Object.fromEntries(
		Object.entries(namespaces).filter(([, policy]) => selectorHasVisibleTools(policy.tools)),
	);
}

function compileNamespaceApproval(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
	annotationPolicy: PortalApprovalConfig['annotationPolicy'],
): PortalApprovalConfig {
	return portalApprovalConfigSchema.parse({
		allowWithoutApprovalTools: namespaceToolRefs(namespaces, (policy) => [
			...selectorAllowList(policy.calls.withoutApproval),
			...(policy.approval?.allowWithoutApproval ?? []),
		]),
		annotationPolicy,
		alwaysAskTools: namespaceToolRefs(namespaces, (policy) => [
			...selectorAllowList(policy.calls.requiresApproval),
			...(policy.approval?.alwaysAsk ?? []),
		]),
		callPoliciesByNamespace: Object.fromEntries(
			Object.entries(namespaces).map(([namespace, policy]) => [namespace, policy.calls]),
		),
		trustedAnnotationNamespaces: Object.entries(namespaces)
			.filter(([, policy]) => policy.approval?.trustedAnnotations)
			.map(([namespace]) => namespace),
		writeTools: namespaceToolRefs(namespaces, (policy) => policy.approval?.write ?? []),
	});
}

function compileEnabledToolsByNamespace(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(namespaces)
			.filter(([, policy]) => policy.tools.allow !== '*')
			.map(([namespace, policy]) => [namespace, selectorAllowList(policy.tools)]),
	);
}

function compileHiddenToolsByNamespace(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(namespaces)
			.filter(([, policy]) => (policy.tools.deny ?? []).length > 0)
			.map(([namespace, policy]) => [namespace, policy.tools.deny ?? []]),
	);
}

function compileProfileFromNamespaces(
	namespaces: AuthoredPortalNamespaces,
	profile: McpPortalProfileDefinition,
): ResolvedMcpPortalProfile {
	const annotationPolicy =
		profile.approval?.annotationPolicy ?? defaultProfile.approval.annotationPolicy;
	const activeNamespacePolicies = activeNamespaces(namespaces);
	return resolvedMcpPortalProfileSchema.parse({
		approval: compileNamespaceApproval(activeNamespacePolicies, annotationPolicy),
		cache: profile.cache ?? defaultProfile.cache,
		enabledNamespaces: Object.keys(activeNamespacePolicies),
		enabledToolsByNamespace: compileEnabledToolsByNamespace(activeNamespacePolicies),
		hiddenToolsByNamespace: compileHiddenToolsByNamespace(activeNamespacePolicies),
		logging: profile.logging ?? defaultProfile.logging,
		promptContext: profile.promptContext ?? defaultProfile.promptContext,
	});
}

export function resolveMcpPortalProfile(
	config: McpPortalConfig,
	profileName: string,
): ResolvedMcpPortalProfile {
	const profile = config.profiles[profileName];
	if (profile === undefined) {
		throw new Error(`unknown MCP profile '${profileName}'`);
	}
	return compileProfileFromNamespaces(profile.namespaces, profile);
}

export function secretValueToEnvironmentReference(secret: SecretValue): string {
	if (secret.source === 'environment') {
		return `\${${secret.name}}`;
	}
	return secret.ref;
}
