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

type ParsedMcpPortalAgentConfig = z.infer<typeof mcpPortalAgentConfigSchema>;
export type McpPortalAgentConfig = Omit<ParsedMcpPortalAgentConfig, 'credentialVersion'> & {
	readonly credentialVersion?: number;
};

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
