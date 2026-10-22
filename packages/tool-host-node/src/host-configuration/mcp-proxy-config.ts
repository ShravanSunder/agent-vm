import {
	mcpPortalProfileDefinitionSchema,
	secretValueSchema,
	type SecretValue,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { loadJsonConfigFile } from '#node-host/host-configuration/json-config-file';
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

export async function loadMcpPortalConfig(configPath: string): Promise<McpPortalConfig> {
	return mcpPortalConfigSchema.parse(await loadJsonConfigFile(configPath));
}

export function secretValueToEnvironmentReference(secret: SecretValue): string {
	if (secret.source === 'environment') {
		return `\${${secret.name}}`;
	}
	return secret.ref;
}
