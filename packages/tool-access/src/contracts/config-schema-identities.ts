export const mcpPortalConfigSchemaVersions = {
	mcp: 1,
	mcpPortal: 1,
	toolPortal: 1,
} as const;

export const mcpPortalConfigSchemaIds = {
	mcp: 'agent-vm:mcp:1',
	mcpPortal: 'agent-vm:mcp-portal:1',
	toolPortal: 'agent-vm:tool-portal:1',
} as const;

export const mcpPortalConfigSchemaPaths = {
	mcpFromGatewayConfig: '../../schemas/mcp.schema.json',
	mcpPortalFromGatewayConfig: '../../schemas/mcp-portal.schema.json',
	toolPortalFromGatewayConfig: '../../schemas/tool-portal.schema.json',
} as const;
