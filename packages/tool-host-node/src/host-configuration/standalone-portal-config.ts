import {
	secretValueSchema,
	toolPortalAgentConfigSchema,
	toolPortalCallPolicySchema,
	toolPortalToolSelectorSchema,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { loadJsonConfigFile } from '#node-host/host-configuration/json-config-file';
export const toolPortalStandaloneAgentAuthenticationSchema = z
	.object({
		approvalHmacKey: secretValueSchema,
		bearerKey: secretValueSchema,
		credentialVersion: z.number().int().positive(),
	})
	.strict();

export type ToolPortalStandaloneAgentAuthentication = z.infer<
	typeof toolPortalStandaloneAgentAuthenticationSchema
>;

export const toolPortalStandaloneAuthenticationSchema = z
	.object({
		agents: z.record(z.string().min(1), toolPortalStandaloneAgentAuthenticationSchema),
	})
	.strict();

export type ToolPortalStandaloneAuthentication = z.infer<
	typeof toolPortalStandaloneAuthenticationSchema
>;

export const toolPortalNetworkAddressSchema = z
	.object({
		host: z.string().min(1),
		port: z.number().int().min(1).max(65_535),
	})
	.strict();

export type ToolPortalNetworkAddress = z.infer<typeof toolPortalNetworkAddressSchema>;

const toolPortalBearerEntrypointAuthenticationSchema = z
	.object({
		kind: z.literal('bearer'),
	})
	.strict();

const toolPortalEntrypointRouteSchema = z
	.string()
	.min(1)
	.refine((route) => route.startsWith('/'), {
		message: 'Tool Portal entrypoint routes must start with "/".',
	});

export const toolPortalHttpEntrypointSchema = z
	.object({
		address: toolPortalNetworkAddressSchema,
		allowedHosts: z.array(z.string().min(1)).min(1),
		allowedOrigins: z.array(z.string().url()),
		authentication: toolPortalBearerEntrypointAuthenticationSchema,
		enabled: z.literal(true),
		route: toolPortalEntrypointRouteSchema,
	})
	.strict();

export type ToolPortalHttpEntrypoint = z.infer<typeof toolPortalHttpEntrypointSchema>;

export const toolPortalMcpEntrypointSchema = z
	.object({
		address: toolPortalNetworkAddressSchema,
		allowedHosts: z.array(z.string().min(1)).min(1),
		allowedOrigins: z.array(z.string().url()),
		authentication: toolPortalBearerEntrypointAuthenticationSchema,
		enabled: z.literal(true),
		route: toolPortalEntrypointRouteSchema,
		transport: z.literal('streamable-http'),
	})
	.strict();

export type ToolPortalMcpEntrypoint = z.infer<typeof toolPortalMcpEntrypointSchema>;

export const toolPortalStdioEntrypointSchema = z
	.object({
		authentication: z
			.object({
				agentId: z.string().min(1),
				kind: z.literal('scoped-principal'),
			})
			.strict(),
		enabled: z.literal(true),
	})
	.strict();

export type ToolPortalStdioEntrypoint = z.infer<typeof toolPortalStdioEntrypointSchema>;

export const toolPortalStandaloneEntrypointsSchema = z
	.object({
		http: toolPortalHttpEntrypointSchema.optional(),
		mcp: toolPortalMcpEntrypointSchema.optional(),
		stdio: toolPortalStdioEntrypointSchema.optional(),
	})
	.strict();

export type ToolPortalStandaloneEntrypoints = z.infer<typeof toolPortalStandaloneEntrypointsSchema>;

const standaloneToolPortalProfileDefinitionSchema = z
	.object({
		namespaces: z
			.record(
				z.string().min(1),
				z
					.object({
						calls: toolPortalCallPolicySchema,
						tools: toolPortalToolSelectorSchema,
						backend: z.object({ kind: z.literal('mcp_provider') }).strict(),
					})
					.strict(),
			)
			.default({}),
	})
	.strict();

export const standaloneToolPortalConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		agents: z.record(z.string().min(1), toolPortalAgentConfigSchema).default({}),
		authentication: toolPortalStandaloneAuthenticationSchema,
		drain: z
			.object({
				timeoutMs: z.number().int().positive(),
			})
			.strict(),
		entrypoints: toolPortalStandaloneEntrypointsSchema,
		mode: z.literal('standalone'),
		profiles: z.record(z.string().min(1), standaloneToolPortalProfileDefinitionSchema),
		schemaVersion: z.literal(1),
	})
	.strict();

export type StandaloneToolPortalConfig = z.infer<typeof standaloneToolPortalConfigSchema>;

export function validateStandaloneToolPortalConfig(
	config: StandaloneToolPortalConfig,
	context: z.RefinementCtx,
): void {
	if (Object.keys(config.profiles).length === 0) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'tool-portal.config.jsonc must define at least one profile.',
			path: ['profiles'],
		});
	}

	for (const [agentId, agentConfig] of Object.entries(config.agents)) {
		if (config.profiles[agentConfig.profile] === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Tool Portal agent "${agentId}" references missing profile "${agentConfig.profile}".`,
				path: ['agents', agentId, 'profile'],
			});
		}
	}
	const configuredAgentIds = Object.keys(config.agents);
	if (configuredAgentIds.length === 0) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'Standalone Tool Portal must define at least one agent.',
			path: ['agents'],
		});
	}

	for (const configuredAgentId of configuredAgentIds) {
		if (config.authentication.agents[configuredAgentId] === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Standalone Tool Portal agent "${configuredAgentId}" is missing authentication material.`,
				path: ['authentication', 'agents', configuredAgentId],
			});
		}
	}

	for (const authenticatedAgentId of Object.keys(config.authentication.agents)) {
		if (config.agents[authenticatedAgentId] === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Standalone Tool Portal authentication references unknown agent "${authenticatedAgentId}".`,
				path: ['authentication', 'agents', authenticatedAgentId],
			});
		}
	}

	if (Object.values(config.entrypoints).every((entrypoint) => entrypoint === undefined)) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'Standalone Tool Portal must explicitly enable at least one entrypoint.',
			path: ['entrypoints'],
		});
	}

	const stdioAgentId = config.entrypoints.stdio?.authentication.agentId;
	if (stdioAgentId !== undefined && config.agents[stdioAgentId] === undefined) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Standalone Tool Portal stdio principal references unknown agent "${stdioAgentId}".`,
			path: ['entrypoints', 'stdio', 'authentication', 'agentId'],
		});
	}
}

export async function loadStandaloneToolPortalConfig(
	configPath: string,
): Promise<StandaloneToolPortalConfig> {
	return standaloneToolPortalConfigSchema
		.superRefine(validateStandaloneToolPortalConfig)
		.parse(await loadJsonConfigFile(configPath));
}
