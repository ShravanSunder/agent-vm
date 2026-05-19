import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';
import { secretValueSchema, type SecretValue } from './secret-value.js';

const mcpProviderDiscoverySchema = z
	.object({
		summary: z.string().min(1).optional(),
	})
	.strict();

const streamableHttpTransportSchema = z
	.object({
		kind: z.literal('streamable-http'),
		url: z.string().url(),
		headers: z.record(z.string(), secretValueSchema).default({}),
		requiredEgressHosts: z.array(z.string().min(1)).default([]),
	})
	.strict();

const sseTransportSchema = z
	.object({
		kind: z.literal('sse'),
		url: z.string().url(),
		headers: z.record(z.string(), secretValueSchema).default({}),
		requiredEgressHosts: z.array(z.string().min(1)).default([]),
	})
	.strict();

const stdioTransportSchema = z
	.object({
		kind: z.literal('stdio'),
		command: z.string().min(1),
		args: z.array(z.string()).default([]),
		cwd: z.string().min(1).optional(),
		env: z.record(z.string(), secretValueSchema).default({}),
		networkAccess: z.enum(['declared', 'none']).optional(),
		requiredEgressHosts: z.array(z.string().min(1)).default([]),
	})
	.strict();

export const mcpSecretPolicySchema = z
	.object({
		hosts: z.array(z.string()).default([]),
		injection: z.enum(['env', 'http-mediation']),
	})
	.strict();

export const mcpProviderSchema = z
	.object({
		kind: z.literal('mcp'),
		namespace: z.string().min(1),
		discovery: mcpProviderDiscoverySchema.default({}),
		secretPolicies: z.record(z.string().min(1), mcpSecretPolicySchema).default({}),
		transport: z.discriminatedUnion('kind', [
			streamableHttpTransportSchema,
			sseTransportSchema,
			stdioTransportSchema,
		]),
	})
	.strict();

export const mcpConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		schemaVersion: z.literal(1),
		providers: z.record(z.string().min(1), mcpProviderSchema).default({}),
	})
	.strict();

export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpProvider = z.infer<typeof mcpProviderSchema>;

export type ResolvedMcpProvider =
	| {
			readonly headers: Readonly<Record<string, SecretValue>>;
			readonly namespace: string;
			readonly transport: 'streamable-http' | 'sse';
			readonly url: string;
	  }
	| {
			readonly args: readonly string[];
			readonly command: string;
			readonly cwd?: string;
			readonly env: Readonly<Record<string, SecretValue>>;
			readonly namespace: string;
			readonly transport: 'stdio';
	  };

export async function loadMcpConfig(configPath: string): Promise<McpConfig> {
	return mcpConfigSchema.parse(await loadJsonConfigFile(configPath));
}

export function mcpConfigToResolvedProviders(config: McpConfig): readonly ResolvedMcpProvider[] {
	return Object.values(config.providers).map((provider) => {
		const transport = provider.transport;
		if (transport.kind === 'stdio') {
			const resolvedProvider: {
				args: readonly string[];
				command: string;
				cwd?: string;
				env: Readonly<Record<string, SecretValue>>;
				namespace: string;
				transport: 'stdio';
			} = {
				args: transport.args,
				command: transport.command,
				env: transport.env,
				namespace: provider.namespace,
				transport: transport.kind,
			};
			if (transport.cwd !== undefined) {
				resolvedProvider.cwd = transport.cwd;
			}
			return resolvedProvider;
		}

		return {
			headers: transport.headers,
			namespace: provider.namespace,
			transport: transport.kind,
			url: transport.url,
		};
	});
}
