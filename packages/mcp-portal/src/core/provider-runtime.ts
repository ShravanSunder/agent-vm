import {
	formatSecretValue,
	mcpConfigToResolvedProviders,
	type FormattedSecretValue,
	type McpConfig,
	type ResolvedMcpProvider,
} from '@agent-vm/config-contracts';

import type { NormalizedUpstreamMcpServer } from '../upstream-mcp-client-runtime.js';

export interface ResolveUpstreamServersProps {
	readonly config: McpConfig;
	readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
}

async function resolveProviderSecretRecord(
	secrets: Readonly<Record<string, FormattedSecretValue>>,
	resolveSecret: (secret: FormattedSecretValue) => Promise<string>,
): Promise<Readonly<Record<string, string>>> {
	const resolvedEntries = await Promise.all(
		Object.entries(secrets).map(
			async ([name, secret]) =>
				[name, formatSecretValue(secret, await resolveSecret(secret))] as const,
		),
	);
	return Object.fromEntries(resolvedEntries);
}

async function resolveUpstreamServer(
	provider: ResolvedMcpProvider,
	resolveSecret: (secret: FormattedSecretValue) => Promise<string>,
): Promise<NormalizedUpstreamMcpServer> {
	if (provider.transport === 'stdio') {
		return {
			args: provider.args,
			command: provider.command,
			...(provider.connectionTimeoutMs === undefined
				? {}
				: { connectionTimeoutMs: provider.connectionTimeoutMs }),
			...(provider.cwd === undefined ? {} : { cwd: provider.cwd }),
			env: await resolveProviderSecretRecord(provider.env, resolveSecret),
			namespace: provider.namespace,
			transport: 'stdio',
		};
	}

	return {
		...(provider.connectionTimeoutMs === undefined
			? {}
			: { connectionTimeoutMs: provider.connectionTimeoutMs }),
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
