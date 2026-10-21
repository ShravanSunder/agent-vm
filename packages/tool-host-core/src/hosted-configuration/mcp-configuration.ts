import type {
	McpConfig,
	ResolvedMcpProvider,
} from '#tool-host-core/hosted-configuration/models/mcp-configuration';
import type { FormattedSecretValue } from '#tool-host-core/hosted-configuration/models/secret-values';

export function mcpConfigToResolvedProviders(config: McpConfig): readonly ResolvedMcpProvider[] {
	return Object.values(config.providers).map((provider) => {
		const transport = provider.transport;
		if (transport.kind === 'stdio') {
			const resolvedProvider: {
				args: readonly string[];
				command: string;
				connectionTimeoutMs?: number;
				cwd?: string;
				env: Readonly<Record<string, FormattedSecretValue>>;
				namespace: string;
				transport: 'stdio';
			} = {
				args: transport.args,
				command: transport.command,
				env: transport.env,
				namespace: provider.namespace,
				transport: transport.kind,
			};
			if (transport.connectionTimeoutMs !== undefined) {
				resolvedProvider.connectionTimeoutMs = transport.connectionTimeoutMs;
			}
			if (transport.cwd !== undefined) {
				resolvedProvider.cwd = transport.cwd;
			}
			return resolvedProvider;
		}

		const resolvedProvider: {
			connectionTimeoutMs?: number;
			headers: Readonly<Record<string, FormattedSecretValue>>;
			namespace: string;
			transport: 'streamable-http' | 'sse';
			url: string;
		} = {
			headers: transport.headers,
			namespace: provider.namespace,
			transport: transport.kind,
			url: transport.url,
		};
		if (transport.connectionTimeoutMs !== undefined) {
			resolvedProvider.connectionTimeoutMs = transport.connectionTimeoutMs;
		}
		return resolvedProvider;
	});
}
