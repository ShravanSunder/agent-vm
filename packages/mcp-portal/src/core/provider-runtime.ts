import {
	mcpConfigToResolvedProviders,
	type McpConfig,
	type ResolvedMcpProvider,
	type SecretValue,
} from '@agent-vm/config-contracts';

import type { NormalizedUpstreamMcpServer } from '../upstream-mcp-client-runtime.js';

export interface ResolveUpstreamServersProps {
	readonly config: McpConfig;
	readonly resolveSecret: (secret: SecretValue) => Promise<string>;
}

async function resolveProviderSecretRecord(
	secrets: Readonly<Record<string, SecretValue>>,
	resolveSecret: (secret: SecretValue) => Promise<string>,
): Promise<Readonly<Record<string, string>>> {
	const resolvedEntries = await Promise.all(
		Object.entries(secrets).map(
			async ([name, secret]) => [name, await resolveSecret(secret)] as const,
		),
	);
	return Object.fromEntries(resolvedEntries);
}

async function resolveUpstreamServer(
	provider: ResolvedMcpProvider,
	resolveSecret: (secret: SecretValue) => Promise<string>,
): Promise<NormalizedUpstreamMcpServer> {
	if (provider.transport === 'stdio') {
		return {
			args: provider.args,
			command: provider.command,
			...(provider.cwd === undefined ? {} : { cwd: provider.cwd }),
			env: await resolveProviderSecretRecord(provider.env, resolveSecret),
			namespace: provider.namespace,
			transport: 'stdio',
		};
	}

	return {
		headers: await resolveProviderSecretRecord(provider.headers, resolveSecret),
		namespace: provider.namespace,
		transport: provider.transport,
		url: provider.url,
	};
}

export async function resolveUpstreamServers(
	props: ResolveUpstreamServersProps,
): Promise<readonly NormalizedUpstreamMcpServer[]> {
	return await Promise.all(
		mcpConfigToResolvedProviders(props.config).map(async (provider) =>
			resolveUpstreamServer(provider, props.resolveSecret),
		),
	);
}
