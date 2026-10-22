import {
	UpstreamMcpError,
	createUpstreamMcpClientRuntime,
	type NormalizedUpstreamMcpServer as RemoteServer,
	type UpstreamMcpClientRuntime,
} from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import { ToolSchema } from '@modelcontextprotocol/core';

import { mcpConfigToResolvedProviders } from '#node-host/host-configuration/mcp-config';
import type { McpConfig } from '#node-host/host-configuration/models/mcp-config';
import type { FormattedSecretValue } from '#node-host/host-configuration/models/secret-value';
import { formatSecretValue } from '#node-host/host-configuration/secret-value';
import type { NormalizedUpstreamMcpServer as StdioServer } from '#node-host/stdio-upstream-servers/models/stdio-upstream-protocol';
import {
	createNodeHttpUpstreamTransport,
	createNodeStdioUpstreamTransport,
} from '#node-host/stdio-upstream-servers/node-upstream-transports';
import { upstreamMcpFailureDetailsFromUnknown as stdioFailureDetailsFromUnknown } from '#node-host/stdio-upstream-servers/stdio-upstream-errors';
import { createNodeStdioUpstreamRuntime } from '#node-host/stdio-upstream-servers/stdio-upstream-runtime';
export type NormalizedNodeUpstreamServer = RemoteServer | StdioServer;
export async function resolveUpstreamServers(props: {
	readonly config: McpConfig;
	readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
}): Promise<readonly NormalizedNodeUpstreamServer[]> {
	async function resolveValues(
		values: Readonly<Record<string, FormattedSecretValue>>,
	): Promise<Readonly<Record<string, string>>> {
		return Object.fromEntries(
			await Promise.all(
				Object.entries(values).map(
					async ([name, secret]): Promise<readonly [string, string]> => [
						name,
						formatSecretValue(secret, await props.resolveSecret(secret)),
					],
				),
			),
		);
	}
	return await Promise.all(
		mcpConfigToResolvedProviders(props.config).map(
			async (provider): Promise<NormalizedNodeUpstreamServer> => {
				const timeout =
					provider.connectionTimeoutMs === undefined
						? {}
						: { connectionTimeoutMs: provider.connectionTimeoutMs };
				return provider.transport === 'stdio'
					? Object.assign(
							{
								namespace: provider.namespace,
								transport: 'stdio' as const,
								command: provider.command,
								args: provider.args,
								env: await resolveValues(provider.env),
							},
							timeout,
							provider.cwd === undefined ? {} : { cwd: provider.cwd },
						)
					: Object.assign(
							{
								namespace: provider.namespace,
								transport: provider.transport,
								url: provider.url,
								headers: await resolveValues(provider.headers),
							},
							timeout,
						);
			},
		),
	);
}
/** Keep the existing stdio diagnostic facts behind the shared error extractor. */
async function withSharedProviderFailure<TResult>(
	operation: () => Promise<TResult>,
): Promise<TResult> {
	try {
		return await operation();
	} catch (error) {
		const details = stdioFailureDetailsFromUnknown(error);
		if (details !== null) throw new UpstreamMcpError(details);
		throw error;
	}
}
/** Build both unchanged outbound transports at the Node boundary. */
export function createNodeProviderRuntime(props: {
	readonly servers: readonly NormalizedNodeUpstreamServer[];
}): UpstreamMcpClientRuntime {
	const remoteServers = props.servers.filter(
		(server): server is RemoteServer => server.transport !== 'stdio',
	);
	const stdioServers = props.servers.filter(
		(server): server is StdioServer => server.transport === 'stdio',
	);
	const remote = createUpstreamMcpClientRuntime({
		servers: remoteServers,
		createUpstreamMcpTransport: createNodeHttpUpstreamTransport,
	});
	const stdio = createNodeStdioUpstreamRuntime({
		servers: stdioServers,
		createUpstreamMcpTransport: createNodeStdioUpstreamTransport(),
	});
	const stdioNamespaces = new Set(stdioServers.map((server) => server.namespace));
	return {
		listTools: async (call) =>
			stdioNamespaces.has(call.namespace)
				? (await withSharedProviderFailure(async () => await stdio.listTools(call))).map((tool) =>
						ToolSchema.parse(tool),
					)
				: await remote.listTools(call),
		callTool: async (call) =>
			stdioNamespaces.has(call.namespace)
				? await withSharedProviderFailure(async () => await stdio.callTool(call))
				: await remote.callTool(call),
		closeAgentScope: async (scope) => {
			await Promise.all([remote.closeAgentScope(scope), stdio.closeAgentScope(scope)]);
		},
		closeSession: async (scope) => {
			await Promise.all([remote.closeSession(scope), stdio.closeSession(scope)]);
		},
	};
}
