import {
	secretValueToEnvironmentReference,
	type McpPortalConfig,
	type OpenClawMcpPortalPluginConfig,
} from '@agent-vm/config-contracts';
import type { GatewayZoneAgentConfig } from '@agent-vm/gateway-interface';
import { portalServerNameForAgent } from '@agent-vm/openclaw-mcp-portal-plugin';

export interface OpenClawMcpServerEntry {
	readonly headers: Readonly<Record<string, string>>;
	readonly transport: 'streamable-http';
	readonly url: string;
}

export interface OpenClawMcpPortalMaterialization {
	readonly mcpServers: Readonly<Record<string, OpenClawMcpServerEntry>>;
	readonly pluginConfig: OpenClawMcpPortalPluginConfig;
}

export interface OpenClawMcpPortalMaterializationOptions {
	readonly agents: readonly GatewayZoneAgentConfig[];
	readonly binPath?: string;
	readonly configDir: string;
	readonly mcpPortalConfig: McpPortalConfig;
}

export function buildOpenClawMcpPortalMaterialization(
	options: OpenClawMcpPortalMaterializationOptions,
): OpenClawMcpPortalMaterialization {
	const pluginConfig: OpenClawMcpPortalPluginConfig = {
		configDir: options.configDir,
		...(options.binPath === undefined ? {} : { binPath: options.binPath }),
	};
	const mcpServers: Record<string, OpenClawMcpServerEntry> = {};
	for (const agent of options.agents) {
		if (options.mcpPortalConfig.agents[agent.id] === undefined) {
			throw new Error(`missing MCP Portal profile binding for agent '${agent.id}'`);
		}
		mcpServers[portalServerNameForAgent(agent.id)] = {
			headers: {
				[options.mcpPortalConfig.server.accessHeader.name]: secretValueToEnvironmentReference(
					options.mcpPortalConfig.server.accessHeader.secret,
				),
			},
			transport: 'streamable-http',
			url: `http://${options.mcpPortalConfig.server.host}:${String(
				options.mcpPortalConfig.server.port,
			)}/agents/${encodeURIComponent(agent.id)}/mcp`,
		};
	}

	return {
		mcpServers,
		pluginConfig,
	};
}
