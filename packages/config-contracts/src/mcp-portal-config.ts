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

export const portalApprovalConfigSchema = z
	.object({
		allowWithoutApprovalTools: z.array(namespaceToolRefSchema).default([]),
		alwaysAskTools: z.array(namespaceToolRefSchema).default([]),
		annotationPolicy: z
			.enum(['destructive-requires-approval', 'always-require-approval'])
			.default('destructive-requires-approval'),
		trustedAnnotationNamespaces: z.array(z.string().min(1)).default([]),
		writeTools: z.array(namespaceToolRefSchema).default([]),
	})
	.strict();

export type PortalApprovalConfig = z.infer<typeof portalApprovalConfigSchema>;

export const mcpPortalProfileDefinitionSchema = z
	.object({
		extends: z.string().min(1).optional(),
		enabledNamespaces: z.array(z.string().min(1)).optional(),
		enabledToolsByNamespace: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
		hiddenToolsByNamespace: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
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
		approval: portalApprovalConfigSchema.optional(),
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

const mcpPortalAccessHeaderSchema = z
	.object({
		name: z.string().min(1),
		secret: secretValueSchema,
	})
	.strict();

export const mcpPortalServerSchema = z
	.object({
		host: z.string().min(1).default('127.0.0.1'),
		port: z.number().int().min(1).max(65_535).default(18_790),
		accessHeader: mcpPortalAccessHeaderSchema,
	})
	.strict();

export type McpPortalServerConfig = z.infer<typeof mcpPortalServerSchema>;

export const mcpPortalAgentConfigSchema = z
	.object({
		profile: z.string().min(1),
		hmacKey: secretValueSchema.optional(),
	})
	.strict();

export type McpPortalAgentConfig = z.infer<typeof mcpPortalAgentConfigSchema>;

export const mcpPortalConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		schemaVersion: z.literal(1),
		server: mcpPortalServerSchema,
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

export type McpPortalConfig = z.infer<typeof mcpPortalConfigSchema>;

export const openClawMcpPortalPluginConfigSchema = z
	.object({
		configDir: z.string().min(1),
		binPath: z.string().min(1).optional(),
	})
	.strict();

export type OpenClawMcpPortalPluginConfig = z.infer<typeof openClawMcpPortalPluginConfigSchema>;

const defaultProfile: ResolvedMcpPortalProfile = {
	approval: portalApprovalConfigSchema.parse({}),
	cache: { catalogTtlMs: 60_000 },
	enabledNamespaces: [],
	enabledToolsByNamespace: {},
	hiddenToolsByNamespace: {},
	logging: { enabled: false },
	promptContext: { enabled: true, maxNamespaces: 12 },
};

interface ResolveProfileState {
	readonly stack: readonly string[];
}

export async function loadMcpPortalConfig(configPath: string): Promise<McpPortalConfig> {
	return mcpPortalConfigSchema.parse(await loadJsonConfigFile(configPath));
}

function mergeProfile(
	base: ResolvedMcpPortalProfile,
	override: McpPortalProfileDefinition,
): ResolvedMcpPortalProfile {
	return resolvedMcpPortalProfileSchema.parse({
		approval: override.approval ?? base.approval,
		cache: override.cache ?? base.cache,
		enabledNamespaces: override.enabledNamespaces ?? base.enabledNamespaces,
		enabledToolsByNamespace: override.enabledToolsByNamespace ?? base.enabledToolsByNamespace,
		hiddenToolsByNamespace: override.hiddenToolsByNamespace ?? base.hiddenToolsByNamespace,
		logging: override.logging ?? base.logging,
		promptContext: override.promptContext ?? base.promptContext,
	});
}

function resolveMcpPortalProfileWithState(
	config: McpPortalConfig,
	profileName: string,
	state: ResolveProfileState,
): ResolvedMcpPortalProfile {
	const profile = config.profiles[profileName];
	if (profile === undefined) {
		throw new Error(`unknown MCP profile '${profileName}'`);
	}
	if (state.stack.includes(profileName)) {
		throw new Error(`MCP profile inheritance cycle: ${[...state.stack, profileName].join(' -> ')}`);
	}

	const parentProfile =
		profile.extends === undefined
			? defaultProfile
			: resolveMcpPortalProfileWithState(config, profile.extends, {
					stack: [...state.stack, profileName],
				});
	return mergeProfile(parentProfile, profile);
}

export function resolveMcpPortalProfile(
	config: McpPortalConfig,
	profileName: string,
): ResolvedMcpPortalProfile {
	return resolveMcpPortalProfileWithState(config, profileName, { stack: [] });
}

export function secretValueToEnvironmentReference(secret: SecretValue): string {
	if (secret.source === 'environment') {
		return `\${${secret.name}}`;
	}
	return secret.ref;
}
